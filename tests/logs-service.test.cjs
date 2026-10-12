jest.mock('@vercel/functions', () => ({ waitUntil: jest.fn() }));
jest.mock('../src/config/sqlServerClient', () => ({ __esModule: true, default: { api_logs: { create: jest.fn() } } }));

const { waitUntil } = require('@vercel/functions');
const prisma = require('../src/config/sqlServerClient').default;
const logs = require('../src/api/services/logsService').default;
const payload = { api_name: 'searchMealsV2', method: 'GET', request_url: 'https://example.test/api/v2/meals/search',
  request_input: { query: 'tea' }, response: 'Meals fetched successfully', error_resp: '' };

test('slow log writes do not block responses and remain registered with Vercel', async () => {
  let finish;
  prisma.api_logs.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await logs.createLog(payload);
  expect(waitUntil).toHaveBeenCalledTimes(1);
  expect(prisma.api_logs.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
    api_name: 'searchMealsV2', status: 'success', request_input: '{"query":"tea"}',
  }) }));
  const task = waitUntil.mock.calls[0][0];
  let completed = false;
  task.then(() => { completed = true; });
  await Promise.resolve();
  expect(completed).toBe(false);
  finish({ id: 'log-id' });
  await task;
  expect(completed).toBe(true);
});

test('background logging errors are observed without rejecting the request', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    prisma.api_logs.create.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(logs.createLog(payload)).resolves.toBeUndefined();
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});

test('error responses are still recorded as errors', async () => {
  prisma.api_logs.create.mockResolvedValueOnce({ id: 'log-id' });
  await logs.createLog({ ...payload, error_resp: new Error('invalid request'), errorType: 'validation' });
  await waitUntil.mock.calls[0][0];
  expect(prisma.api_logs.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
    status: 'error', error_type: 'validation',
  }) }));
});
