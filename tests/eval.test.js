import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import { updateMeetingState, judgeConfidence } from '../src/lib/meetingState.js';

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ---- Test cases ----
// Each case: a sequence of transcript chunks fed in order (simulating a
// meeting), plus ground truth - the action items a human would agree
// are genuinely there, and whether each SHOULD have been confident
// enough to auto-ticket vs flagged for review.
const testCases = [
  {
    name: 'Clear single item',
    chunks: ["John, can you handle the deploy by Friday?"],
    groundTruth: [
      { gist: 'Handle the deploy', owner: 'John', deadline: 'Friday', shouldAutoTicket: true }
    ]
  },
  {
    name: 'Two items, one update',
    chunks: [
      "John, can you handle the deploy by Friday?",
      "We also need someone to update the client-facing docs before launch.",
      "Actually, let's push John's deploy deadline to Monday instead."
    ],
    groundTruth: [
      { gist: 'Handle the deploy', owner: 'John', deadline: 'Monday', shouldAutoTicket: true },
      { gist: 'Update client-facing docs', owner: 'unspecified', deadline: 'before launch', shouldAutoTicket: false }
      // no clear owner -> should NOT auto-ticket
    ]
  },
  {
    name: 'Vague item - should be flagged for review, not ticketed',
    chunks: ["Someone should probably look into that caching thing at some point."],
    groundTruth: [
      { gist: 'Look into caching issue', owner: 'unspecified', deadline: 'none', shouldAutoTicket: false }
    ]
  },
  {
    name: 'No action items - pure discussion',
    chunks: ["I think the roadmap looks solid overall. Good alignment across the team."],
    groundTruth: [] // nothing should be extracted - tests against hallucination
  }
];

// ---- LLM-based fuzzy matcher ----
// Extracted item text won't match ground truth word-for-word (LLMs
// paraphrase). Instead of brittle string matching, we ask the model
// directly: "do these represent the same real commitment?"
const matchSchema = {
  type: Type.OBJECT,
  properties: {
    isMatch: { type: Type.BOOLEAN }
  },
  required: ['isMatch']
};

async function isSameCommitment(extractedItem, groundTruthItem) {
  const prompt = `
Extracted item: text="${extractedItem.text}", owner="${extractedItem.owner}", deadline="${extractedItem.deadline}"
Ground truth item: gist="${groundTruthItem.gist}", owner="${groundTruthItem.owner}", deadline="${groundTruthItem.deadline}"

Do these represent the SAME real-world commitment (same task, same owner, same deadline meaning)?
`;
  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: prompt,
    config: { responseMimeType: 'application/json', responseSchema: matchSchema }
  });
  return JSON.parse(response.text).isMatch;
}

// ---- Run one test case through the real pipeline ----
async function runCase(testCase) {
  let state = { actionItems: [] };

  for (const chunk of testCase.chunks) {
    state = await updateMeetingState(state, chunk);
  }

  const extracted = state.actionItems;

  // --- Score extraction: precision & recall via matching ---
  const matchedGroundTruth = new Set();
  const matchedExtracted = new Set();

  for (const gt of testCase.groundTruth) {
    for (const item of extracted) {
      if (matchedExtracted.has(item.id)) continue; // each extracted item can only match once
      const match = await isSameCommitment(item, gt);
      if (match) {
        matchedGroundTruth.add(gt);
        matchedExtracted.add(item.id);
        gt._matchedItem = item; // stash for confidence-gating check below
        break;
      }
    }
  }

  const truePositives = matchedGroundTruth.size;
  const falseNegatives = testCase.groundTruth.length - truePositives; // ground truth items we missed
  const falsePositives = extracted.length - matchedExtracted.size;    // extracted items with no matching ground truth (hallucinations)

  // --- Score confidence gating, only for correctly-matched items ---
  let gatingCorrect = 0;
  let gatingTotal = 0;

  for (const gt of testCase.groundTruth) {
    if (!gt._matchedItem) continue; // can't judge gating on an item we never even extracted
    gatingTotal++;
    const judgment = await judgeConfidence(gt._matchedItem);
    if (judgment.isConfident === gt.shouldAutoTicket) {
      gatingCorrect++;
    }
  }

  return {
    name: testCase.name,
    truePositives,
    falseNegatives,
    falsePositives,
    gatingCorrect,
    gatingTotal,
    extractedCount: extracted.length,
    groundTruthCount: testCase.groundTruth.length
  };
}

// ---- Run all cases and aggregate ----
async function runEval() {
  const results = [];

  for (const testCase of testCases) {
    console.log(`\nRunning: ${testCase.name}...`);
    const result = await runCase(testCase);
    results.push(result);
    console.log(`  Extracted ${result.extractedCount}, ground truth ${result.groundTruthCount}`);
    console.log(`  TP=${result.truePositives} FN=${result.falseNegatives} FP=${result.falsePositives}`);
    console.log(`  Gating correct: ${result.gatingCorrect}/${result.gatingTotal}`);
  }

  const totalTP = results.reduce((s, r) => s + r.truePositives, 0);
  const totalFN = results.reduce((s, r) => s + r.falseNegatives, 0);
  const totalFP = results.reduce((s, r) => s + r.falsePositives, 0);
  const totalGatingCorrect = results.reduce((s, r) => s + r.gatingCorrect, 0);
  const totalGatingCases = results.reduce((s, r) => s + r.gatingTotal, 0);

  const precision = totalTP / (totalTP + totalFP) || 0;
  const recall = totalTP / (totalTP + totalFN) || 0;
  const f1 = (2 * precision * recall) / (precision + recall) || 0;
  const gatingAccuracy = totalGatingCorrect / totalGatingCases || 0;

  console.log('\n=== OVERALL RESULTS ===');
  console.log(`Precision: ${(precision * 100).toFixed(1)}%`);
  console.log(`Recall: ${(recall * 100).toFixed(1)}%`);
  console.log(`F1: ${(f1 * 100).toFixed(1)}%`);
  console.log(`Confidence-gating accuracy: ${(gatingAccuracy * 100).toFixed(1)}%`);
}

runEval().catch(err => {
  console.error('Error during evaluation:', err);
  process.exit(1);
});

// test('Run evaluation suite', async () => {
//   await runEval();
// });