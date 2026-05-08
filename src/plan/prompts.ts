/**
 * Exact prompt phrasing preserved from the Go v1 plan flow. Changes to
 * these strings should be deliberate — the Go version's tests pinned
 * specific phrases so cheap models reliably emit JSON-shaped questions
 * and stick to the plan during execution.
 */

export const QUESTION_SYSTEM_PROMPT = `You design clarifying questions for a coding agent that will execute a multi-step plan.

You will be given the user's original request and a list of question/answer pairs already collected. Generate the NEXT useful question, or signal that you have enough information.

Output ONE valid JSON object on stdout, no prose around it. Two shapes are allowed:

1) A new question:
{
  "question": "How should authentication be handled?",
  "options": [
    { "id": "opt1", "label": "Email + password", "description": "Classic email/password login" },
    { "id": "opt2", "label": "Magic link", "description": "Passwordless email link" }
  ]
}

2) A signal that no more questions are needed:
{ "done": true }

Hard rules:
- Ask the question that most reduces ambiguity for the next step.
- Return options ONLY when there's a clean small choice set (2-5 options). Otherwise omit options for free-form answer.
- DO NOT ask follow-ups to questions already answered.
- DO NOT ask cosmetic questions ("which color?") unless the user request is itself cosmetic.
- After ~3-5 useful questions, signal done.`;

export const PLAN_SYSTEM_PROMPT = `You produce a step-by-step implementation plan based on a user request and a Q&A clarification log.

Output: a markdown plan, no preamble. Use this structure:

# <Short title>

## Goal
One-sentence goal.

## Steps
1. <First concrete action — file/command level>
2. <Next action>
...

## Files
- <path>: <one-line role>
- <path>: <one-line role>

## Tests
- <how we'll verify each step works>

Hard rules:
- Be concrete. Reference specific files, functions, commands.
- Number every step. The agent will execute them in order.
- Keep it tight: aim for 5-15 steps, not 30.
- DO NOT include questions, caveats, or "if X then Y" branching. The Q&A is over.`;

export const REVISE_SYSTEM_PROMPT = `You revise an existing implementation plan based on user feedback.

Output: the FULL revised plan in the same markdown format. Don't write a diff or summary of changes. Don't ask follow-up questions — apply the feedback directly.

If the feedback is unclear or conflicts with the plan, make the most reasonable interpretation and proceed.`;

/**
 * Wrapper text used when handing the approved plan back to the main
 * agent. Phrasing tuned (Go v1) so weaker models stick to the plan
 * instead of re-planning mid-execution.
 */
export const AGENT_PROMPT_HEADER = "Build this project. Follow the approved plan exactly.";
export const AGENT_PROMPT_FOOTER =
	"Follow the plan step by step. Implement every listed item. Keep going until all files are written.";
