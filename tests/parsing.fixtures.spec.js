describe('parsing fixtures', () => {
  it('normalizes empty price', () => {
    const { parsePriceGBP } = require('../src/utils/price');
    expect(parsePriceGBP('')).toEqual({ amount: null, currency: 'GBP' });
  });
});
