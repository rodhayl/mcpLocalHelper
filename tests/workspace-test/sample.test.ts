// Sample test file
import { calculateSum, greet } from './sample';

describe('Sample tests', () => {
  it('should calculate sum correctly', () => {
    expect(calculateSum(2, 3)).toBe(5);
  });

  it('should greet correctly', () => {
    expect(greet('World')).toBe('Hello, World!');
  });
});
