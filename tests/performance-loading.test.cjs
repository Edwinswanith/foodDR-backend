describe('Vercel performance guards', () => {
  const originalApiKey = process.env.GEMINI_API_KEY;
  const originalFetch = global.fetch;

  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalApiKey;
  });

  test('nutrition controller does not eagerly load image and barcode services', () => {
    jest.isolateModules(() => {
      jest.doMock('../src/api/services/scanMealService', () => {
        throw new Error('scan service was loaded eagerly');
      });
      jest.doMock('../src/api/services/gemini/mealRecognitionService', () => {
        throw new Error('recognition service was loaded eagerly');
      });

      expect(() => require('../src/api/controller/nutritionController').default).not.toThrow();
    });
  });

  test('coalesces and briefly caches identical AI food-search fallbacks', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '["chicken", "rice"]' }] } }] }),
    });
    const { interpretFoodSearchQuery } = require('../src/api/services/gemini/foodSearchService');

    const [first, concurrent] = await Promise.all([
      interpretFoodSearchQuery('Chkn rice'),
      interpretFoodSearchQuery('chkn RICE'),
    ]);
    const repeated = await interpretFoodSearchQuery('CHKN RICE');

    expect(first).toEqual(['chicken', 'rice']);
    expect(concurrent).toEqual(first);
    expect(repeated).toEqual(first);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('briefly caches an unavailable AI fallback', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    global.fetch = jest.fn().mockRejectedValue(new Error('provider unavailable'));
    const { interpretFoodSearchQuery } = require('../src/api/services/gemini/foodSearchService');

    await expect(interpretFoodSearchQuery('unknown dish phrase')).resolves.toBeNull();
    await expect(interpretFoodSearchQuery('UNKNOWN DISH PHRASE')).resolves.toBeNull();

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
