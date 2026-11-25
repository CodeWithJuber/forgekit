// Calibrate a fixed-horizon regression advisory on separate, stable windows.
import { cusum } from "./anchor.js";

const subjectKeys = ["provider", "model", "revision", "protocolSha256"];
const label = (s) => typeof s === "string" && s.length > 0 && s.length <= 512 && s.trim() === s;
const proportion = (v) => typeof v === "number" && v > 0 && v <= 1;

export function monitorModel(input) {
  const { subject, anchors, alpha, meaningfulDrop, horizon, fit, calibration, evaluation } =
    input ?? {};
  if (
    input?.schemaVersion !== 1 ||
    !subject ||
    !subjectKeys.every((k) => label(subject[k])) ||
    !/^[a-f0-9]{64}$/.test(subject.protocolSha256)
  )
    throw new Error(
      "Specify schemaVersion 1 and frozen provider, model, revision and protocolSha256",
    );
  if (input.independentRuns !== true || input.stableHistory !== true)
    throw new Error("Declare independent runs and stable historical fit and calibration windows");
  if (
    !Array.isArray(anchors) ||
    !anchors.length ||
    !anchors.every(label) ||
    new Set(anchors).size !== anchors.length
  )
    throw new Error("Anchor IDs must form a nonempty, unique frozen task set");
  if (
    !proportion(alpha) ||
    alpha >= 1 ||
    !proportion(meaningfulDrop) ||
    !Number.isSafeInteger(horizon) ||
    horizon < 1
  )
    throw new Error("Declare the per-window alpha, meaningfulDrop and positive integer horizon");
  if (
    ![fit, calibration, evaluation].every(Array.isArray) ||
    evaluation.length > horizon ||
    !calibration.every((w) => Array.isArray(w) && w.length === horizon)
  )
    throw new Error(
      "Provide fit runs, equal-horizon calibration windows, and one evaluation window",
    );
  const ids = new Set();
  let lastTime = Number.NEGATIVE_INFINITY;
  function failureRate(run) {
    if (!run || !label(run.id) || ids.has(run.id)) throw new Error("Every run needs a distinct ID");
    ids.add(run.id);
    const utc =
      typeof run.at === "string" && run.at.length === 20 ? run.at.replace(/Z$/, ".000Z") : run.at;
    const time = typeof utc === "string" ? Date.parse(utc) : NaN;
    if (!Number.isFinite(time) || time <= lastTime || new Date(time).toISOString() !== utc)
      throw new Error("Runs must have valid, strictly increasing UTC timestamps across all splits");
    lastTime = time;
    if (!subjectKeys.every((k) => run.subject?.[k] === subject[k]))
      throw new Error("Observation differs from the frozen provider, model, revision or protocol");
    const outcomes = run.outcomes;
    if (
      !outcomes ||
      typeof outcomes !== "object" ||
      Array.isArray(outcomes) ||
      Object.keys(outcomes).length !== anchors.length ||
      !anchors.every((a) => Object.hasOwn(outcomes, a) && typeof outcomes[a] === "boolean")
    )
      throw new Error("Every run must include one boolean outcome for each identical anchor");
    return anchors.reduce((failed, a) => failed + Number(!outcomes[a]), 0) / anchors.length;
  }
  const fitRates = fit.map(failureRate);
  const calibrationRates = calibration.map((w) => w.map(failureRate));
  const evaluationRates = evaluation.map(failureRate);
  const n = calibration.length;
  // r is an order statistic over the n calibration windows plus the unseen window.
  const rank = n + 1 - Math.floor((n + 1) * alpha);
  const result = {
    schemaVersion: 1,
    subject: Object.fromEntries(subjectKeys.map((k) => [k, subject[k]])),
    anchors: anchors.length,
    horizon,
    alpha,
    meaningfulDrop,
    fitRuns: fit.length,
    calibrationWindows: n,
    evaluationRuns: evaluation.length,
    advisory: true,
  };
  if (!fitRates.length || !n || rank > n || evaluation.length < horizon)
    return {
      ...result,
      status: "cold-start",
      reason: !fitRates.length
        ? "missing-fit"
        : !n || rank > n
          ? "insufficient-calibration"
          : "incomplete-evaluation",
    };
  const expectedFailureRate = fitRates.reduce((a, b) => a + b, 0) / fitRates.length;
  const k = expectedFailureRate + meaningfulDrop / 2;
  const peak = (chart) => chart.C.reduce((max, c) => Math.max(max, c), 0);
  const peaks = calibrationRates
    .map((values) => peak(cusum(values, { k, h: Infinity })))
    .sort((a, b) => a - b);
  const boundary = peaks[rank - 1];
  const chart = cusum(evaluationRates, { k, h: boundary });
  const maximum = peak(chart);
  const pValue = (1 + peaks.filter((x) => x >= maximum).length) / (n + 1);
  return {
    ...result,
    status: chart.alarm ? "review" : "normal",
    expectedPassRate: 1 - expectedFailureRate,
    boundary,
    rank,
    evaluationMaximum: maximum,
    pValue,
    firstCrossingRunId: chart.alarm ? evaluation[chart.firstAlarm].id : null,
  };
}
