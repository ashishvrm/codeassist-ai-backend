const { processResponse, STATES, computeTextSimilarity } = require('../src/state/machine');
const sessionStore = require('../src/state/session');

// Set env variables before tests
process.env.PREFERRED_LANGUAGE = 'python';
process.env.MAX_CONTEXT_MESSAGES = '20';

describe('State Machine', () => {
  let sessionId;

  beforeEach(() => {
    const session = sessionStore.createSession('python');
    sessionId = session.id;
  });

  afterEach(() => {
    sessionStore.endSession(sessionId);
  });

  describe('processResponse', () => {
    it('should return error for non-existent session', () => {
      const result = processResponse('fake-id', { phase: 'idle' });
      expect(result.action).toBe('error');
    });

    it('should handle idle phase', () => {
      const result = processResponse(sessionId, {
        phase: 'idle',
        extractedText: 'Loading screen',
      });
      expect(result.action).toBe('monitoring');
      expect(result.phase).toBe(STATES.IDLE);
    });

    it('should handle reading_question with solution', () => {
      const result = processResponse(sessionId, {
        phase: 'reading_question',
        difficulty: 'easy',
        extractedText: 'Two Sum problem',
        problemTitle: 'Two Sum',
        solution: {
          language: 'python',
          approach: 'Use a hash map',
          optimalCode: 'def twoSum(nums, target): ...',
          timeComplexity: 'O(n)',
          spaceComplexity: 'O(n)',
          edgeCases: ['empty array'],
        },
      });
      expect(result.action).toBe('solution');
      expect(result.phase).toBe(STATES.SOLUTION_GENERATED);
      expect(result.solution).toBeDefined();
      expect(result.questionNumber).toBe(1);
    });

    it('should handle reading_question without solution', () => {
      const result = processResponse(sessionId, {
        phase: 'reading_question',
        extractedText: 'Partial problem visible',
      });
      expect(result.action).toBe('monitoring');
      expect(result.phase).toBe(STATES.READING_QUESTION);
    });

    it('should handle error_detected with fix', () => {
      // First, set up a solution
      processResponse(sessionId, {
        phase: 'reading_question',
        solution: { optimalCode: 'def sol(): pass' },
      });

      const result = processResponse(sessionId, {
        phase: 'error_detected',
        extractedText: 'IndexError',
        error: {
          errorText: 'IndexError: list index out of range',
          cause: 'Off by one',
          fixedCode: 'def sol(): return []',
        },
      });
      expect(result.action).toBe('error_fix');
      expect(result.error).toBeDefined();
    });

    it('should handle coding phase', () => {
      const result = processResponse(sessionId, {
        phase: 'coding',
        extractedText: 'User typing code',
      });
      expect(result.action).toBe('monitoring');
      // First coding frame stays in SOLUTION_GENERATED; after 5+ unchanged → MONITORING
      expect(result.phase).toBe(STATES.SOLUTION_GENERATED);
    });

    it('should detect new question by title change', () => {
      // Set up Q1
      sessionStore.updateSession(sessionId, {
        questionNumber: 1,
        currentProblemTitle: 'Two Sum',
        currentProblemContext: 'Given an array find two numbers that add up to target',
      });

      const result = processResponse(sessionId, {
        phase: 'new_question',
        problemTitle: 'Reverse Linked List',
        extractedText: 'Reverse a singly linked list and return the new head',
        solution: {
          optimalCode: 'def reverseList(head): ...',
          approach: 'Iterative pointer reversal',
          timeComplexity: 'O(n)',
          spaceComplexity: 'O(1)',
        },
      });
      expect(result.action).toBe('new_question');
      expect(result.questionNumber).toBe(2);
    });

    it('should track error escalation', () => {
      sessionStore.updateSession(sessionId, {
        questionNumber: 1,
        errorCycleCount: 2,
      });

      const result = processResponse(sessionId, {
        phase: 'error_detected',
        error: {
          errorText: 'Wrong answer',
          cause: 'Logic error',
          fixedCode: 'def sol(): return 42',
        },
      });
      expect(result.needsEscalation).toBe(true);
    });
  });

  describe('computeTextSimilarity', () => {
    it('should return 0 for empty strings', () => {
      expect(computeTextSimilarity('', '')).toBe(0);
      expect(computeTextSimilarity('hello', '')).toBe(0);
    });

    it('should return 1 for identical strings', () => {
      expect(computeTextSimilarity('hello world', 'hello world')).toBe(1);
    });

    it('should return low similarity for different strings', () => {
      const sim = computeTextSimilarity(
        'find two numbers that add up to target',
        'reverse a singly linked list node'
      );
      expect(sim).toBeLessThan(0.3);
    });

    it('should return high similarity for similar strings', () => {
      const sim = computeTextSimilarity(
        'find two numbers in array that sum to target',
        'find two numbers in the array that add up to target value'
      );
      expect(sim).toBeGreaterThan(0.5);
    });
  });
});
