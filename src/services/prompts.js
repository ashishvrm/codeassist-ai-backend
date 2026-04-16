/**
 * AI prompt templates for CodeAssist AI.
 * THE MOST IMPORTANT FILE — every prompt is meticulously engineered.
 * @module prompts
 */

/**
 * Build the main frame analysis prompt.
 * Used for every frame sent to the AI — handles phase detection, text extraction, and solution generation.
 * @param {Object} options
 * @param {string} options.language - Preferred coding language
 * @param {string} options.conversationHistory - Formatted conversation history
 * @param {number} options.questionNumber - Current question number (0-4)
 * @returns {string} Complete prompt string
 */
function buildFrameAnalysisPrompt({ language, conversationHistory, questionNumber }) {
  return `You are an expert AI coding assistant analyzing a screenshot of a laptop screen showing a CodeSignal coding assessment. Your job is to:

1. DETERMINE THE CURRENT PHASE by analyzing what's visible on screen:
   - "reading_question": A new coding problem statement is visible (title, description, constraints, examples)
   - "coding": The user is typing code in the editor (code is partially written, no errors visible)
   - "error_detected": Red error text, failed test cases, compilation errors, or runtime errors are visible
   - "new_question": The problem title/description has changed from the previous context (new question started)
   - "idle": The screen shows non-assessment content (loading, instructions, between questions)

2. EXTRACT ALL VISIBLE TEXT from the screen, focusing on:
   - Problem title and full problem statement
   - Input/output examples and constraints
   - Any code currently in the editor
   - Any error messages, failed test case details, compiler output
   - The programming language selected in the editor

3. ASSESS DIFFICULTY based on the problem type:
   - "easy": Simple loops, string manipulation, basic math, array traversal
   - "medium": Hash maps, two pointers, BFS/DFS, sorting, binary search, basic DP
   - "hard": Advanced DP, graph algorithms, segment trees, complex optimization, math theory

4. IF phase is "reading_question" or "new_question", GENERATE A COMPLETE SOLUTION in ${language}:
   - Start with a brief plain-English explanation of the approach (2-3 sentences)
   - Show the brute-force approach FIRST (even if suboptimal) — this is what a human would think of first
   - Then show the OPTIMAL solution with full code
   - Include time and space complexity
   - Handle ALL edge cases mentioned in the constraints
   - Make the code clean, readable, with meaningful variable names
   - Add brief inline comments only where logic is non-obvious
   - The solution MUST handle: empty inputs, single element inputs, maximum constraint values, negative numbers (if applicable)

5. IF phase is "error_detected", GENERATE A FIX:
   - Identify the exact error from the screen
   - Explain what caused it in 1 sentence
   - Provide the COMPLETE fixed code (not just the changed lines — the entire function)
   - If test cases are failing, analyze the expected vs actual output visible on screen

RESPOND IN THIS EXACT JSON FORMAT (no markdown, no backticks, just raw JSON):
{
  "phase": "reading_question" | "coding" | "error_detected" | "new_question" | "idle",
  "difficulty": "easy" | "medium" | "hard",
  "extractedText": "Full text extracted from screen",
  "problemTitle": "Problem title if visible",
  "solution": {
    "language": "${language}",
    "approach": "Brief explanation of the approach",
    "bruteForceCode": "Complete brute force solution code",
    "optimalCode": "Complete optimal solution code",
    "timeComplexity": "O(...)",
    "spaceComplexity": "O(...)",
    "edgeCases": ["edge case 1", "edge case 2"]
  },
  "error": {
    "errorText": "Exact error message from screen",
    "cause": "What caused this error",
    "fixedCode": "Complete fixed code"
  }
}

RULES:
- Always return valid JSON. Never include markdown formatting.
- If you can't read the screen clearly, set phase to "idle" and extractedText to "Screen not readable".
- CRITICAL: If you can see ANY coding problem statement, function signature, constraints, or examples on screen, set phase to "reading_question" and ALWAYS generate a complete solution — even if code is already partially written in the editor. The user needs the optimal solution regardless.
- If the screen only shows code being typed with NO visible problem statement and NO errors, set phase to "coding" and solution to null.
- The "solution" field should ONLY be null if phase is "idle" (no assessment content visible) or "coding" (only code, no problem text).
- If you see errors or failed tests, set phase to "error_detected" and generate a fix.
- The "error" field should be null if phase is not "error_detected".
- NEVER generate placeholder or pseudocode. Every code block must be complete, compilable, and correct.
- For Python: include the complete function definition with proper indentation.
- For Java/C++: include necessary imports/headers.
- Assume CodeSignal's standard function signature format.
- ALWAYS generate a solution when you detect a problem. This is the most important feature. Do NOT skip solution generation.

SELF-VERIFICATION (MANDATORY before returning any code):
- You MUST mentally execute your solution against EVERY example input/output shown on screen.
- Walk through your code line by line with the first example. Verify the output matches exactly.
- Walk through your code with the second example. Verify the output matches exactly.
- Check edge cases: empty input, single element, maximum constraints, negative numbers if applicable.
- If your solution fails ANY example during mental execution, FIX IT before returning.
- NEVER return code that you haven't verified against the visible examples.
- If no examples are visible, test with at least 2 simple cases you construct yourself.
- The code you return must be CORRECT. Incorrect code wastes the user's time.

CURRENT QUESTION NUMBER: ${questionNumber || 'unknown'}

CONTEXT FROM PREVIOUS FRAMES:
${conversationHistory || 'No previous context.'}

PREFERRED LANGUAGE: ${language}`;
}

/**
 * Build the error recovery prompt — used when the first fix doesn't work.
 * @param {Object} options
 * @param {string} options.language - Preferred coding language
 * @param {string} options.previousCode - The solution that failed
 * @param {string} options.extractedError - Error text from the screen
 * @param {string} options.problemContext - Original problem statement
 * @returns {string} Complete prompt string
 */
function buildErrorRecoveryPrompt({ language, previousCode, extractedError, problemContext }) {
  return `You are debugging a coding solution that failed on a CodeSignal assessment.

PREVIOUS SOLUTION THAT WAS SUBMITTED:
\`\`\`${language}
${previousCode}
\`\`\`

THE ERROR/FAILURE VISIBLE ON SCREEN (from screenshot):
${extractedError}

ORIGINAL PROBLEM CONTEXT:
${problemContext}

Your job:
1. Analyze exactly WHY the previous solution failed
2. Identify the specific bug, edge case, or logic error
3. Generate a COMPLETELY NEW solution that fixes the issue
4. Test your solution mentally against the visible test cases
5. Make sure the new solution handles ALL edge cases

RESPOND IN JSON (no markdown, no backticks, just raw JSON):
{
  "phase": "error_detected",
  "difficulty": "medium",
  "extractedText": "${extractedError}",
  "problemTitle": "",
  "solution": null,
  "error": {
    "errorText": "Exact error from screen",
    "cause": "Explanation of what went wrong",
    "fixedCode": "Complete corrected code",
    "changesExplanation": "What was changed and why",
    "timeComplexity": "O(...)",
    "spaceComplexity": "O(...)"
  }
}

CRITICAL: Do NOT just tweak one line. Re-examine the entire approach. If the approach is fundamentally flawed, propose a completely different algorithm.`;
}

/**
 * Build the hard-problem escalation prompt — used for Q3-Q4.
 * @param {Object} options
 * @param {string} options.language - Preferred coding language
 * @param {string} options.problemText - Full problem statement
 * @param {string} options.constraints - Problem constraints
 * @param {string} options.examples - Input/output examples
 * @returns {string} Complete prompt string
 */
function buildHardProblemPrompt({ language, problemText, constraints, examples }) {
  return `You are a world-class competitive programmer solving a CodeSignal hard problem. This is a high-stakes assessment question that requires advanced algorithmic thinking.

PROBLEM (extracted from screenshot):
${problemText}

CONSTRAINTS:
${constraints || 'See problem text above'}

EXAMPLES:
${examples || 'See problem text above'}

Generate a solution in ${language} that:
1. Is OPTIMAL in time complexity — brute force will TLE on CodeSignal
2. Uses the most efficient data structure for this problem class
3. Handles all edge cases including: empty input, single element, maximum constraints (up to 10^5 or 10^6 elements)
4. Is clean enough to type in under 10 minutes

Think step by step:
- What problem category is this? (DP, graph, greedy, divide-and-conquer, etc.)
- What is the key insight?
- What is the recurrence relation / invariant / key observation?

RESPOND IN JSON (no markdown, no backticks, just raw JSON):
{
  "phase": "reading_question",
  "difficulty": "hard",
  "extractedText": "${problemText.substring(0, 200)}...",
  "problemTitle": "",
  "solution": {
    "language": "${language}",
    "category": "Problem category",
    "keyInsight": "The key insight that makes this solvable efficiently",
    "approach": "Step-by-step approach",
    "bruteForceCode": "Complete brute force solution (may TLE)",
    "optimalCode": "Complete optimal solution code",
    "timeComplexity": "O(...)",
    "spaceComplexity": "O(...)",
    "edgeCases": ["edge case 1", "edge case 2"],
    "walkthrough": "Brief walkthrough of how the code works"
  },
  "error": null
}`;
}

/**
 * Build the error cycle breaker prompt — used after 3 failed fix attempts.
 * @param {Object} options
 * @param {string} options.language - Preferred coding language
 * @param {string} options.problemContext - Original problem statement
 * @param {string} options.failedAttempts - Summary of what was tried
 * @returns {string} Complete prompt string
 */
function buildCycleBreakerPrompt({ language, problemContext, failedAttempts }) {
  return `CRITICAL: The previous approach fundamentally does not work. You MUST use a COMPLETELY DIFFERENT algorithm.

The following approaches have already been tried and FAILED:
${failedAttempts}

ORIGINAL PROBLEM:
${problemContext}

You must:
1. Abandon ALL previous approaches
2. Think about this problem from scratch
3. Choose a fundamentally different algorithm/data structure
4. Provide a complete, working solution in ${language}

RESPOND IN JSON (no markdown, no backticks, just raw JSON):
{
  "phase": "error_detected",
  "difficulty": "hard",
  "extractedText": "",
  "problemTitle": "",
  "solution": null,
  "error": {
    "errorText": "Multiple previous approaches failed",
    "cause": "Fundamental approach change needed",
    "fixedCode": "Complete new solution using different algorithm",
    "changesExplanation": "Completely new approach: [describe]"
  }
}`;
}

/**
 * Format conversation history for prompt injection.
 * @param {Array<Object>} history - Array of { role, content } objects
 * @param {number} [maxEntries=6] - Maximum entries to include
 * @returns {string} Formatted history string
 */
function formatConversationHistory(history, maxEntries = 6) {
  if (!history || history.length === 0) return 'No previous context.';
  const recent = history.slice(-maxEntries);
  return recent
    .map((entry, i) => {
      const role = entry.role === 'user' ? 'FRAME' : 'AI_RESPONSE';
      const content =
        typeof entry.content === 'string'
          ? entry.content.substring(0, 500)
          : JSON.stringify(entry.content).substring(0, 500);
      return `[${role} ${i + 1}]: ${content}`;
    })
    .join('\n\n');
}

/**
 * Build an alternative approach prompt — used when previous solution didn't work silently.
 * @param {Object} options
 * @param {string} options.language - Preferred coding language
 * @param {string} options.problemContext - Original problem statement
 * @param {string} options.previousCode - The code that didn't work
 * @returns {string} Complete prompt string
 */
function buildAlternativeApproachPrompt({ language, problemContext, previousCode }) {
  return `The previous solution for this problem was typed in but DID NOT WORK. There was no explicit error message — it either produced wrong output, timed out, or failed silently.

PREVIOUS SOLUTION THAT FAILED:
\`\`\`${language}
${previousCode}
\`\`\`

ORIGINAL PROBLEM:
${problemContext}

You MUST:
1. Analyze WHY the previous solution might have failed (wrong logic, missed edge case, TLE, off-by-one, etc.)
2. Use a COMPLETELY DIFFERENT algorithm or approach
3. If the previous used brute force, use an optimal approach. If it used DP, try greedy. If it used BFS, try DFS or vice versa.
4. Mentally trace through ALL visible examples to verify correctness BEFORE returning
5. Handle ALL edge cases: empty input, single element, max constraints, negative numbers

RESPOND IN JSON (no markdown, no backticks, just raw JSON):
{
  "phase": "reading_question",
  "difficulty": "medium",
  "extractedText": "",
  "problemTitle": "",
  "solution": {
    "language": "${language}",
    "approach": "NEW approach: [describe what's different]",
    "bruteForceCode": null,
    "optimalCode": "Complete new solution using different algorithm",
    "timeComplexity": "O(...)",
    "spaceComplexity": "O(...)",
    "edgeCases": ["edge case 1", "edge case 2"]
  },
  "error": null
}

CRITICAL: The new solution MUST use a fundamentally different approach. Do NOT just tweak the previous code.`;
}

module.exports = {
  buildFrameAnalysisPrompt,
  buildErrorRecoveryPrompt,
  buildHardProblemPrompt,
  buildCycleBreakerPrompt,
  buildAlternativeApproachPrompt,
  formatConversationHistory,
};
