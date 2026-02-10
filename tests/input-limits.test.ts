/**
 * Tests for input resource limits
 * 
 * Validates that input limits are properly enforced to prevent:
 * - Resource exhaustion attacks (100KB+ strings, 1000+ parameters)
 * - Memory exhaustion from massive inputs
 * - DoS via compute-intensive operations on large inputs
 */

import { describe, it, expect } from 'vitest';
import { checkInputLimits, INPUT_LIMITS, BoundedStrings, BoundedNumbers } from '../src/utils/input-limits.js';

describe('Input Limits', () => {
  describe('checkInputLimits', () => {
    it('should accept inputs within limits', () => {
      const result = checkInputLimits({
        query: 'search for function',
        path: '/src/index.ts',
        maxResults: 100,
      });
      expect(result).toBeNull();
    });

    it('should reject query strings exceeding limit', () => {
      const longQuery = 'a'.repeat(INPUT_LIMITS.QUERY_MAX_LENGTH + 1);
      const result = checkInputLimits({ query: longQuery });
      expect(result).not.toBeNull();
      expect(result).toContain('query');
      expect(result).toContain('exceeds maximum length');
    });

    it('should reject path strings exceeding limit', () => {
      const longPath = 'a'.repeat(INPUT_LIMITS.PATH_MAX_LENGTH + 1);
      const result = checkInputLimits({ path: longPath });
      expect(result).not.toBeNull();
      expect(result).toContain('path');
      expect(result).toContain('exceeds maximum length');
    });

    it('should reject content strings exceeding limit', () => {
      const longContent = 'x'.repeat(INPUT_LIMITS.CONTENT_MAX_LENGTH + 1);
      const result = checkInputLimits({ content: longContent });
      expect(result).not.toBeNull();
      expect(result).toContain('content');
      expect(result).toContain('exceeds maximum length');
    });

    it('should reject arrays exceeding limit', () => {
      const longArray = Array(INPUT_LIMITS.MAX_ARRAY_LENGTH + 1).fill('item');
      const result = checkInputLimits({ files: longArray });
      expect(result).not.toBeNull();
      expect(result).toContain('files');
      expect(result).toContain('exceeds maximum array length');
    });

    it('should accept arrays within limit', () => {
      const okArray = Array(INPUT_LIMITS.MAX_ARRAY_LENGTH).fill('item');
      const result = checkInputLimits({ files: okArray });
      expect(result).toBeNull();
    });

    it('should accept empty objects', () => {
      const result = checkInputLimits({});
      expect(result).toBeNull();
    });

    it('should handle mixed valid parameters', () => {
      const result = checkInputLimits({
        action: 'intelligent',
        root: '/src',
        query: 'find function',
        maxResults: 20,
        files: ['a.ts', 'b.ts'],
      });
      expect(result).toBeNull();
    });
  });

  describe('INPUT_LIMITS constants', () => {
    it('should have reasonable query limit', () => {
      expect(INPUT_LIMITS.QUERY_MAX_LENGTH).toBe(10_000);
    });

    it('should have reasonable path limit', () => {
      expect(INPUT_LIMITS.PATH_MAX_LENGTH).toBe(1_000);
    });

    it('should have reasonable content limit', () => {
      expect(INPUT_LIMITS.CONTENT_MAX_LENGTH).toBe(100_000);
    });

    it('should have reasonable array limit', () => {
      expect(INPUT_LIMITS.MAX_ARRAY_LENGTH).toBe(100);
    });

    it('should have reasonable max results limit', () => {
      expect(INPUT_LIMITS.MAX_RESULTS_LIMIT).toBe(1000);
    });
  });

  describe('BoundedStrings schemas', () => {
    it('should validate path strings', () => {
      // Valid path
      expect(() => BoundedStrings.path.parse('/src/index.ts')).not.toThrow();
      
      // Empty path should fail
      expect(() => BoundedStrings.path.parse('')).toThrow();
      
      // Too long path should fail
      const longPath = 'a'.repeat(INPUT_LIMITS.PATH_MAX_LENGTH + 1);
      expect(() => BoundedStrings.path.parse(longPath)).toThrow();
    });

    it('should validate query strings', () => {
      // Valid query
      expect(() => BoundedStrings.query.parse('search term')).not.toThrow();
      
      // Empty query should fail
      expect(() => BoundedStrings.query.parse('')).toThrow();
      
      // Too long query should fail
      const longQuery = 'a'.repeat(INPUT_LIMITS.QUERY_MAX_LENGTH + 1);
      expect(() => BoundedStrings.query.parse(longQuery)).toThrow();
    });

    it('should validate optional paths', () => {
      // Valid path
      expect(() => BoundedStrings.optionalPath.parse('/src/index.ts')).not.toThrow();
      
      // Undefined should pass
      expect(() => BoundedStrings.optionalPath.parse(undefined)).not.toThrow();
      
      // Too long path should fail
      const longPath = 'a'.repeat(INPUT_LIMITS.PATH_MAX_LENGTH + 1);
      expect(() => BoundedStrings.optionalPath.parse(longPath)).toThrow();
    });
  });

  describe('BoundedNumbers schemas', () => {
    it('should validate maxResults', () => {
      // Valid values
      expect(() => BoundedNumbers.maxResults.parse(10)).not.toThrow();
      expect(() => BoundedNumbers.maxResults.parse(undefined)).not.toThrow();
      
      // Zero should fail (min is 1)
      expect(() => BoundedNumbers.maxResults.parse(0)).toThrow();
      
      // Exceeding limit should fail
      expect(() => BoundedNumbers.maxResults.parse(INPUT_LIMITS.MAX_RESULTS_LIMIT + 1)).toThrow();
      
      // Non-integer should fail
      expect(() => BoundedNumbers.maxResults.parse(10.5)).toThrow();
    });

    it('should validate depth', () => {
      // Valid values
      expect(() => BoundedNumbers.depth.parse(5)).not.toThrow();
      expect(() => BoundedNumbers.depth.parse(0)).not.toThrow();
      expect(() => BoundedNumbers.depth.parse(undefined)).not.toThrow();
      
      // Negative should fail
      expect(() => BoundedNumbers.depth.parse(-1)).toThrow();
      
      // Exceeding limit should fail
      expect(() => BoundedNumbers.depth.parse(INPUT_LIMITS.MAX_DEPTH + 1)).toThrow();
    });

    it('should validate timeout', () => {
      // Valid values
      expect(() => BoundedNumbers.timeoutMs.parse(5000)).not.toThrow();
      expect(() => BoundedNumbers.timeoutMs.parse(undefined)).not.toThrow();
      
      // Below minimum should fail
      expect(() => BoundedNumbers.timeoutMs.parse(500)).toThrow();
      
      // Exceeding limit should fail
      expect(() => BoundedNumbers.timeoutMs.parse(INPUT_LIMITS.MAX_TIMEOUT_MS + 1)).toThrow();
    });
  });
});
