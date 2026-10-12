jest.mock('../src/config/sqlServerClient', () => ({ __esModule: true, default: {
  user_nutrition_profiles: { upsert: jest.fn() },
} }));
jest.mock('../src/config/mysqlConnection', () => ({ connectToMySQLDatabase: jest.fn() }));

const prisma = require('../src/config/sqlServerClient').default;
const service = require('../src/api/services/commonService').default;
beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

test('aggressiveness database constraint failures return a field error without Prisma details', async () => {
  prisma.user_nutrition_profiles.upsert.mockRejectedValueOnce({
    code: 'P2003', meta: { constraint: 'CK__users__goal_aggr__6B0FDBE9' },
    message: 'Invalid prisma upsert invocation at /private/internal/path',
  });
  await expect(service.upsertInTable('user_nutrition_profiles', { id: 'test' }, {}, {}))
    .rejects.toMatchObject({ statusCode: 400, message: 'Aggressiveness must be mild, moderate or aggressive.' });
});

test('other upsert failures do not expose raw database errors', async () => {
  prisma.user_nutrition_profiles.upsert.mockRejectedValueOnce(new Error('Internal SQL and filesystem details'));
  await expect(service.upsertInTable('user_nutrition_profiles', { id: 'test' }, {}, {}))
    .rejects.toMatchObject({ statusCode: 400, message: 'Unable to save record.' });
});
