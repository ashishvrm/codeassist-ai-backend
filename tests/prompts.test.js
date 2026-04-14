const prompts = require('../src/services/prompts');

describe('Prompt Templates', () => {
  describe('buildFrameAnalysisPrompt', () => {
    it('should produce a valid prompt with all placeholders filled', () => {
      const result = prompts.buildFrameAnalysisPrompt({
        language: 'python',
        conversationHistory: 'Frame 1: question detected',
        questionNumber: 2,
      });
      expect(result).toContain('python');
      expect(result).toContain('Frame 1: question detected');
      expect(result).toContain('2');
      expect(result).not.toContain('{LANGUAGE}');
      expect(result).not.toContain('{CONVERSATION_HISTORY}');
    });

    it('should handle empty conversation history', () => {
      const result = prompts.buildFrameAnalysisPrompt({
        language: 'java',
        conversationHistory: '',
        questionNumber: 0,
      });
      expect(result).toContain('java');
      expect(result).toContain('PREFERRED LANGUAGE: java');
    });
  });

  describe('buildErrorRecoveryPrompt', () => {
    it('should include previous code and error details', () => {
      const result = prompts.buildErrorRecoveryPrompt({
        language: 'python',
        previousCode: 'def solution(arr): return arr[0]',
        extractedError: 'IndexError: list index out of range',
        problemContext: 'Find the maximum element in an array',
      });
      expect(result).toContain('def solution(arr): return arr[0]');
      expect(result).toContain('IndexError');
      expect(result).toContain('Find the maximum');
    });
  });

  describe('buildHardProblemPrompt', () => {
    it('should include problem text and language', () => {
      const result = prompts.buildHardProblemPrompt({
        language: 'cpp',
        problemText: 'Find shortest path in weighted graph',
        constraints: 'N <= 10^5',
        examples: 'Input: [[1,2,3]]',
      });
      expect(result).toContain('cpp');
      expect(result).toContain('Find shortest path');
      expect(result).toContain('N <= 10^5');
    });
  });

  describe('buildCycleBreakerPrompt', () => {
    it('should emphasize completely different algorithm', () => {
      const result = prompts.buildCycleBreakerPrompt({
        language: 'python',
        problemContext: 'Two sum problem',
        failedAttempts: 'Brute force O(n^2) failed, hash map failed',
      });
      expect(result).toContain('COMPLETELY DIFFERENT');
      expect(result).toContain('Brute force');
    });
  });

  describe('formatConversationHistory', () => {
    it('should format history entries', () => {
      const history = [
        { role: 'user', content: 'Frame 1 text' },
        { role: 'assistant', content: '{"phase":"reading_question"}' },
      ];
      const result = prompts.formatConversationHistory(history);
      expect(result).toContain('FRAME 1');
      expect(result).toContain('AI_RESPONSE');
    });

    it('should return default message for empty history', () => {
      expect(prompts.formatConversationHistory([])).toBe('No previous context.');
      expect(prompts.formatConversationHistory(null)).toBe('No previous context.');
    });

    it('should limit entries to maxEntries', () => {
      const history = Array.from({ length: 20 }, (_, i) => ({
        role: 'user',
        content: `Frame ${i}`,
      }));
      const result = prompts.formatConversationHistory(history, 4);
      expect(result.split('FRAME').length - 1).toBeLessThanOrEqual(4);
    });
  });
});
