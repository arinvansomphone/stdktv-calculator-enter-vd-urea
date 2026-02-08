import { getNumberValue, calculateVolumeOfPatient, calculateTwice, calculateThrice } from './controller.js';

function calculateConcentrations(initialPUN, p) {
  /*
    p must contain:
      Vtotal, V1ratio, G, Kru, Kic, totalUF,
      sessionLength, UFdistribution (array),
      totalSessionTime, sessions (array of {length,gap}),
      timeBetweenSessions (array)
  */
  const V1base = p.Vtotal * p.V1ratio;           // mL
  const V2     = p.Vtotal - V1base;              // mL – assumed constant

  // UF that occurs while OFF dialysis is spread evenly over off-time
  const fluidRate = (p.totalUF) / (10080 - p.totalSessionTime);   // mL / min added back during off-time

  // UF removed during each session (mL) – supplied as fractions of totalUF
  const UFperSession = p.UFdistribution.map(f => f * p.totalUF);

  // Build a 10 080-minute schedule of 0/1 flags and UF-per-minute values
  const dialysisFlag = new Array(10080).fill(0);   // 1 when on HD
  const UFperMinute  = new Array(10080).fill(0);   // mL/min removed by machine
  let cursor = 0;
  p.sessions.forEach((sess, idx) => {
    // dialysis ON minutes
    for (let i = 0; i < sess.length; i++) {
      dialysisFlag[cursor] = 1;
      UFperMinute[cursor] = UFperSession[idx] / sess.length;
      cursor++;
    }
    // OFF minutes (gap)
    for (let i = 0; i < sess.gap; i++) {
      cursor++;
    }
  });
  // Safety: if schedule shorter than 10080, pad with OFF minutes
  while (cursor < 10080) cursor++;

  // --- state arrays ----
  const C_V1 = new Array(10081);
  const V1   = new Array(10081);

  C_V1[0] = initialPUN;
  V1[0]   = V1base + p.timeBetweenSessions[p.timeBetweenSessions.length-1] * fluidRate; // same pre-load as old code

  let solute_V1 = C_V1[0] * V1[0];          // mg
  const solute_V2_const = initialPUN * V2;  // mg (V2 well mixed, no UF)
  let solute_V2 = solute_V2_const;

  for (let t = 0; t < 10080; t++) {
    // Volume update
    const dV = (dialysisFlag[t] ? -UFperMinute[t] : fluidRate);
    V1[t+1] = V1[t] + dV;

    // Solute fluxes (mg)
    const gen      = p.G;                              // generation
    const exch     = p.Kic * ( (solute_V2 / V2) - C_V1[t] );
    const hdClear  = dialysisFlag[t] ? p.Kd * C_V1[t] : 0;
    const kidney   = p.Kru * C_V1[t];

    solute_V1 += gen + exch - hdClear - kidney;
    solute_V2 -= exch;   // equal/opposite

    C_V1[t+1] = solute_V1 / V1[t+1];
  }

  return C_V1; // length 10081 (0 … 10 080)
}

// ─────────── NEW: find starting PUN that yields steady-state ───────────
function findSteadyStatePUN(params, targetPUN, measuredDay = 'M', tol = 0.01, maxIter = 50) {
  // Calculate offsets dynamically based on session structure
  // For 3x per week (M-W-F): sessions at 0, 2880, 5760
  // For 2x per week: depends on schedule, but we'll calculate from params
  let measurementMinute = 0;
  
  if (params.sessions.length === 3) {
    // 3x per week (M-W-F schedule)
    const dayOffsets = {
      'M': 0,                                         // Monday pre-treatment (start)
      'W': params.sessions[0].length + params.sessions[0].gap,  // After Mon treatment + gap
      'F': params.sessions[0].length + params.sessions[0].gap + 
           params.sessions[1].length + params.sessions[1].gap   // After Mon + Wed treatments + gaps
    };
    measurementMinute = dayOffsets[measuredDay] || 0;
  } else if (params.sessions.length === 2) {
    // 2x per week - use first session (Monday equivalent)
    // Could be extended to handle other days if needed
    measurementMinute = 0;
  }
  
  // Approach: Adjust G (urea generation rate) to match the target measured PUN
  // Use a more robust bisection/damped iteration method
  
  // Create a copy of params to avoid modifying the original
  const testParams = { ...params };
  
  // Helper function to find steady state and get measured PUN for a given G
  const getMeasuredPUN = (G) => {
    testParams.G = G;
    let P0 = targetPUN;  // Use target as initial guess
    for (let i = 0; i < 100; i++) {
      const arr = calculateConcentrations(P0, testParams);
      const endPUN = arr[10080];
      const diff = endPUN - P0;
      if (Math.abs(diff) < 0.00001) {  // Very tight tolerance for steady state
        P0 = endPUN;
        break;
      }
      P0 += 0.5 * diff;
    }
    const steadyConc = calculateConcentrations(P0, testParams);
    return { P0, measuredPUN: steadyConc[measurementMinute], concentrations: steadyConc };
  };
  
  // Binary search bounds for G
  let Glow = 1;  // Lowered from 10 to allow lower G values
  let Ghigh = 5000;
  let bestG = params.G;
  let bestResult = null;
  
  // First, check which direction we need to go
  const initialResult = getMeasuredPUN(params.G);
  console.log(`Initial: G=${params.G}, measured=${(initialResult.measuredPUN*100).toFixed(1)} mg/dL, target=${(targetPUN*100).toFixed(1)} mg/dL`);
  
  if (initialResult.measuredPUN < targetPUN) {
    Glow = params.G;
  } else {
    Ghigh = params.G;
  }
  
  // Binary search for the right G
  for (let iter = 0; iter < maxIter; iter++) {
    const testG = (Glow + Ghigh) / 2;
    const result = getMeasuredPUN(testG);
    const error = result.measuredPUN - targetPUN;
    
    console.log(`Iteration ${iter}: G=${testG.toFixed(2)}, measured PUN=${(result.measuredPUN*100).toFixed(1)} mg/dL, error=${(error*100).toFixed(3)}`);
    
    bestG = testG;
    bestResult = result;
    
    if (Math.abs(error) < 0.001) {  // Tight tolerance: within 0.1 mg/dL
      console.log(`Converged! Final G=${testG.toFixed(2)}`);
      return { PUN: result.P0, concentrations: result.concentrations, adjustedG: testG };
    }
    
    // Adjust bounds
    if (result.measuredPUN < targetPUN) {
      Glow = testG;
    } else {
      Ghigh = testG;
    }
    
    // Check if bounds are too close
    if (Math.abs(Ghigh - Glow) < 0.001) {  // Very tight bound check
      console.log(`Bounds converged at G=${testG.toFixed(3)}, using best result`);
      return { PUN: result.P0, concentrations: result.concentrations, adjustedG: testG };
    }
  }
  
  console.warn('Reached max iterations, using best result');
  return { PUN: bestResult.P0, concentrations: bestResult.concentrations, adjustedG: bestG };
}

function simulateWeek(initialPUN, params) {
  // Re-use the existing week-simulation logic.
  const conc = calculateConcentrations(initialPUN, params);
  return {
    concentrations: conc,
    finalPUN: conc[conc.length - 1]
  };
}

export function drawGraph() {
  const canvas = document.getElementById('myLineChart');
  const ctx = canvas.getContext('2d');
  
  // Clear the canvas first
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const dayTicks = [0, 1440, 2880, 4320, 5760, 7200, 8640];

  //// input parameters
  let Vtotal = calculateVolumeOfPatient() * 1000;
  let G = 5 * 100;
  let sessionlength = calculateThrice(); 
  let totalUF = getNumberValue("weeklyuf") * 1000; // is this UF the input or the calculated? 
  let Kru = getNumberValue("kru");
  let initialPUN = 100;
  let sessionlengthold = getNumberValue("time");
  let Kd = getNumberValue("spKtV_current") * Vtotal / (sessionlengthold) - Kru;
  
  // Read the target pre-treatment PUN and which day it was measured
  let targetPUN = getNumberValue("G") / 100;  // Convert mg/dL to mg/mL (divide by 100)
  let measuredDay = document.querySelector('input[name="pun-unit"]:checked')?.value || 'M';

  //// new 3x per week
  // new 3x per week secondary parameters 
  let timeoff = 10080 - 3 * sessionlength;
  let fluid = totalUF / timeoff;
  let timebetween1_2 = 2 * 1440 - sessionlength;
  let timebetween2_3 = 2 * 1440 - sessionlength;
  let timebetween3_1 = 3 * 1440 - sessionlength;
  let V1 = Vtotal * 1/3;
  let V2 = Vtotal * 2/3;
  let Kic = 0.016 * Vtotal;
  let UFrx1 = 3 / 7 * totalUF;
  let UFrx2 = 2 / 7 * totalUF;
  let UFrx3 = 2 / 7 * totalUF;

  // new 3x per week calculations
  // volume
  let V1begin = [V1 + timebetween3_1 * fluid]
  let dialysison = Array(sessionlength).fill(1)
  dialysison = dialysison.concat(Array(timebetween1_2).fill(0), Array(sessionlength).fill(1), 
  Array(timebetween2_3).fill(0), Array(sessionlength).fill(1), Array(timebetween3_1).fill(0))

  for (let i=0; i < 10080; i++) {
    let reduce; 
    if (i < 2880) {
      reduce = dialysison[i] * UFrx1 / sessionlength
    }
    else if (i < 5760) {
      reduce = dialysison[i] * UFrx2 / sessionlength  
    }
    else {
      reduce = dialysison[i] * UFrx2 / sessionlength
    }
    let add = (1 - dialysison[i]) * fluid
    V1begin.push(V1begin[i] + add - reduce)
  }

  // concentrations
  let C_V1begin = [initialPUN]
  let C_V2begin = [initialPUN]
  let solute_V1 = initialPUN * V1begin[0]
  let solute_V2 = initialPUN * V2

  for (let i=0; i < 10080; i++) {
    let solute_added_by_G = G
    let solute_added_by_V2 = Kic * (C_V2begin[i] - C_V1begin[i])
    let solute_removed_by_HD = Kd * C_V1begin[i] * dialysison[i]
    let solute_removed_by_Kru = Kru * C_V1begin[i]
    solute_V1 = solute_V1 + solute_added_by_G + solute_added_by_V2 - solute_removed_by_HD - solute_removed_by_Kru
    solute_V2 = solute_V2 - solute_added_by_V2
    C_V1begin.push(solute_V1 / V1begin[i + 1])
    C_V2begin.push(solute_V2 / V2)
  }

  // apc and tac
  let tac = 0;
  for (const val of C_V1begin) {
    tac += val;
  }
  tac /= C_V1begin.length;
  let apc = (C_V1begin[0] + C_V1begin[2879] + C_V1begin[5759]) / 3;

  //// new 2x per week
  // 2x per week seconday parameters
  let sessionlength2 = calculateTwice();
  let timeoff2 = 10080 - 2 * sessionlength2;
  let fluid2 = totalUF / timeoff2;
  let timebetween1_22 = 3 * 1440 - sessionlength2;
  let timebetween2_32 = 4 * 1440 - sessionlength2;
  let UFrx12 = 4 / 7 * totalUF;
  let UFrx22 = 3 / 7 * totalUF;

  // twice per week calculations
  // volume
  let V1begin2 = [V1 + timebetween2_32 * fluid2]
  let dialysison2 = Array(sessionlength2).fill(1)
  dialysison2 = dialysison2.concat(Array(timebetween1_22).fill(0), Array(sessionlength2).fill(1), 
  Array(timebetween2_32).fill(0))

  for (let i=0; i < 10080; i++) {
    let reduce; 
    if (i < 4320) {
      reduce = dialysison2[i] * UFrx12 / sessionlength2
    }
    else {
      reduce = dialysison2[i] * UFrx22 / sessionlength2
    }
    let add = (1 - dialysison2[i]) * fluid2
    V1begin2.push(V1begin2[i] + add - reduce)
  }

  // concentrations
  let C_V1begin2 = [initialPUN]
  let C_V2begin2 = [initialPUN]
  let solute_V12 = initialPUN * V1begin2[0]
  let solute_V22 = initialPUN * V2

  for (let i=0; i < 10080; i++) {
    let solute_added_by_G = (1-dialysison2[i]) * G
    let solute_added_by_V2 = Kic * (C_V2begin2[i] - C_V1begin2[i])
    let solute_removed_by_HD = Kd * C_V1begin2[i] * dialysison2[i]
    let solute_removed_by_Kru = Kru * C_V1begin2[i]
    solute_V12 = solute_V12 + solute_added_by_G + solute_added_by_V2 - solute_removed_by_HD - solute_removed_by_Kru
    solute_V22 = solute_V22 - solute_added_by_V2
    C_V1begin2.push(solute_V12 / V1begin2[i + 1])
    C_V2begin2.push(solute_V22 / V2)
  }

  // apc and tac
  let tac2 = 0;
  for (const val of C_V1begin2) {
    tac2 += val;
  }
  tac2 /= C_V1begin2.length;
  let apc2 = (C_V1begin2[0] + C_V1begin2[4319]) / 2;

  //// previous 3x per week
  // secondary parameters
  let timeoffold = 10080 - 3 * sessionlengthold;
  let fluidold = totalUF / timeoffold;
  let timebetween1_2old = 2 * 1440 - sessionlengthold;
  let timebetween2_3old = 2 * 1440 - sessionlengthold;
  let timebetween3_1old = 3 * 1440 - sessionlengthold;

  // previous 3x per week calculations
  // volume
  let V1beginold = [V1 + timebetween3_1old * fluidold]
  let dialysisonold = Array(sessionlengthold).fill(1)
  dialysisonold = dialysisonold.concat(Array(timebetween1_2old).fill(0), Array(sessionlengthold).fill(1), 
  Array(timebetween2_3old).fill(0), Array(sessionlengthold).fill(1), Array(timebetween3_1old).fill(0))

  for (let i=0; i < 10080; i++) {
    let reduce; 
    if (i < 2880) {
      reduce = dialysisonold[i] * UFrx1 / sessionlengthold
    }
    else if (i < 5760) {
      reduce = dialysisonold[i] * UFrx2 / sessionlengthold  
    }
    else {
      reduce = dialysisonold[i] * UFrx2 / sessionlengthold
    }
    let add = (1 - dialysisonold[i]) * fluidold
    V1beginold.push(V1beginold[i] + add - reduce)
  }

  // concentrations
  let C_V1beginold = [initialPUN]
  let C_V2beginold = [initialPUN]
  let solute_V1old = initialPUN * V1beginold[0]
  let solute_V2old = initialPUN * V2

  for (let i=0; i < 10080; i++) {
    let solute_added_by_G = (1-dialysisonold[i]) * G
    let solute_added_by_V2 = Kic * (C_V2beginold[i] - C_V1beginold[i])
    let solute_removed_by_HD = Kd * C_V1beginold[i] * dialysisonold[i]
    let solute_removed_by_Kru = Kru * C_V1beginold[i]
    solute_V1old = solute_V1old + solute_added_by_G + solute_added_by_V2 - solute_removed_by_HD - solute_removed_by_Kru
    solute_V2old = solute_V2old - solute_added_by_V2
    C_V1beginold.push(solute_V1old / V1beginold[i + 1])
    C_V2beginold.push(solute_V2old / V2)
  }

  // apc and tac
  let tacold = 0;
  for (const val of C_V1beginold) {
    tacold += val;
  }
  tacold /= C_V1beginold.length;
  let apcold = (C_V1beginold[0] + C_V1beginold[2879] + C_V1beginold[5759]) / 3;

  // ---- build parameter objects for steady-state solver ----
  const baseParamsSS = { Vtotal, V1ratio: 1/3, G, Kru, Kic, totalUF };

  const params3xOld = {
    ...baseParamsSS,
    sessionLength: sessionlengthold,
    Kd: Kd,
    UFdistribution: [3/7, 2/7, 2/7],
    totalSessionTime: 3 * sessionlengthold,
    sessions: [
      { length: sessionlengthold, gap: timebetween1_2old },
      { length: sessionlengthold, gap: timebetween2_3old },
      { length: sessionlengthold, gap: timebetween3_1old }
    ],
    timeBetweenSessions: [timebetween1_2old, timebetween2_3old, timebetween3_1old]
  };

  const params3xNew = {
    ...baseParamsSS,
    sessionLength: sessionlength,
    Kd: Kd,
    UFdistribution: [3/7, 2/7, 2/7],
    totalSessionTime: 3 * sessionlength,
    sessions: [
      { length: sessionlength, gap: timebetween1_2 },
      { length: sessionlength, gap: timebetween2_3 },
      { length: sessionlength, gap: timebetween3_1 }
    ],
    timeBetweenSessions: [timebetween1_2, timebetween2_3, timebetween3_1]
  };

  const params2xNew = {
    ...baseParamsSS,
    sessionLength: sessionlength2,
    Kd: Kd,
    UFdistribution: [4/7, 3/7],
    totalSessionTime: 2 * sessionlength2,
    sessions: [
      { length: sessionlength2, gap: timebetween1_22 },
      { length: sessionlength2, gap: timebetween2_32 }
    ],
    timeBetweenSessions: [timebetween1_22, timebetween2_32]
  };

  // ---- Steady-state adjustment ----
  console.log('Target PUN:', targetPUN, 'Measured day:', measuredDay);
  
  // Step 1: Find steady-state G using OLD 3×/week schedule
  const result1 = findSteadyStatePUN(params3xOld, targetPUN, measuredDay);
  
  if (!result1 || !result1.adjustedG || !result1.concentrations) {
    console.error('Error: result1 is invalid:', result1);
    alert('Error calculating steady-state for old schedule. Check console.');
    return;
  }
  
  const adjustedG = result1.adjustedG;
  
  console.log('Result1 (Old 3×):', result1);
  console.log('Adjusted G from old schedule:', adjustedG);
  
  // Step 2: Use the same G for NEW schedules and find their steady-state
  params3xNew.G = adjustedG;
  params2xNew.G = adjustedG;
  
  // Helper function to find steady-state PUN with fixed G (no G adjustment)
  const findSteadyStateWithFixedG = (params) => {
    let P0 = targetPUN;  // Initial guess
    for (let i = 0; i < 100; i++) {
      const arr = calculateConcentrations(P0, params);
      const endPUN = arr[10080];
      const diff = endPUN - P0;
      if (Math.abs(diff) < 0.00001) {
        P0 = endPUN;
        break;
      }
      P0 += 0.5 * diff;
    }
    return calculateConcentrations(P0, params);
  };
  
  const result2_concentrations = findSteadyStateWithFixedG(params3xNew);
  const result3_concentrations = findSteadyStateWithFixedG(params2xNew);
  
  console.log('New 3× with fixed G - sample values:', result2_concentrations.slice(0, 5));
  console.log('New 2× with fixed G - sample values:', result3_concentrations.slice(0, 5));
  
  C_V1beginold = result1.concentrations;
  C_V1begin = result2_concentrations;
  C_V1begin2 = result3_concentrations;
  
  console.log('Array lengths:', C_V1beginold?.length, C_V1begin?.length, C_V1begin2?.length);
  
  // Check if arrays have valid data
  if (!C_V1beginold || !C_V1begin || !C_V1begin2) {
    console.error('One or more concentration arrays are undefined!');
    alert('Error: Failed to calculate concentrations. Check console for details.');
    return;
  }
  
  console.log('Sample values from C_V1begin:', C_V1begin.slice(0, 5));
  console.log('Monday pre-treatment PUN:', C_V1begin[0] * 100, 'mg/dL');

  // Convert to mg/dL for display (concentrations are in mg/mL)
  tacold = (C_V1beginold.reduce((s, v) => s + v, 0) / C_V1beginold.length) * 100;
  apcold = ((C_V1beginold[0] + C_V1beginold[2879] + C_V1beginold[5759]) / 3) * 100;

  tac   = (C_V1begin.reduce((s, v) => s + v, 0) / C_V1begin.length) * 100;
  apc   = ((C_V1begin[0] + C_V1begin[2879] + C_V1begin[5759]) / 3) * 100;

  tac2  = (C_V1begin2.reduce((s, v) => s + v, 0) / C_V1begin2.length) * 100;
  apc2  = ((C_V1begin2[0] + C_V1begin2[4319]) / 2) * 100;
  
  console.log('TAC/APC values:', { tacold, apcold, tac, apc, tac2, apc2 });

  /// graphing
  const data = {
      labels: Array.from({ length: 10081 }, (_, i) => i),
      datasets: [
        {
          label: 'Current 3×/wk',
          data: C_V1beginold.map(v => v * 100),  // Convert mg/mL to mg/dL
          fill: false,
          tension: 0.1,
          borderColor: 'rgb(232, 173, 96)',
          borderWidth: 1,
          pointRadius: 1, 
          pointHoverRadius: 4, 
          pointHitRadius: 4,
          pointBackgroundColor: 'rgb(232, 173, 96)',
          backgroundColor: 'transparent'
        },
        {
          label: 'New 3×/wk',
          data: C_V1begin.map(v => v * 100),  // Convert mg/mL to mg/dL
          fill: false,
          tension: 0.1,
          borderColor: 'rgba(75,192,192,1)',
          borderWidth: 1,
          pointRadius: 1,
          pointHoverRadius: 4,
          pointHitRadius: 4,
          pointBackgroundColor: 'rgba(75,192,192,1)',
          backgroundColor: 'transparent'
        },
        {
          label: 'New 2×/wk',
          data: C_V1begin2.map(v => v * 100),  // Convert mg/mL to mg/dL
          fill: false,
          tension: 0.1,
          borderColor: 'rgba(153,102,255,1)',
          borderWidth: 1,
          pointRadius: 1,
          pointHoverRadius: 4,
          pointHitRadius: 4,
          pointBackgroundColor: 'rgba(153,102,255,1)',
          backgroundColor: 'transparent'
        },
        {
          label: 'APC, Current 3×/wk',
          data: Array(10081).fill(apcold),
          borderColor: 'rgb(232, 173, 96)',
          borderWidth: 1.5,
          borderDash: [8, 4],
          pointRadius: 0,
          fill: false,
          tension: 0,
          hidden: true,
          backgroundColor: 'transparent'
        },
        {
          label: 'TAC, Current 3×/wk',
          data: Array(10081).fill(tacold),
          borderColor: 'rgb(232, 173, 96)',
          borderWidth: 1.5,
          borderDash: [2, 4],
          pointRadius: 0,
          fill: false,
          tension: 0,
          hidden: true,
          backgroundColor: 'transparent'
        },
        {
          label: 'APC, New 3×/wk',
          data: Array(10081).fill(apc),
          borderColor: 'rgba(75,192,192,1)',
          borderWidth: 1.5,
          borderDash: [8, 4],
          pointRadius: 0,
          fill: false,
          tension: 0,
          hidden: true,
          backgroundColor: 'transparent'
        },
        {
          label: 'TAC, New 3×/wk',
          data: Array(10081).fill(tac),
          borderColor: 'rgba(75,192,192,1)',
          borderWidth: 1.5,
          borderDash: [2, 4],
          pointRadius: 0,
          fill: false,
          tension: 0,
          hidden: true,
          backgroundColor: 'transparent'
        },
        {
          label: 'APC, New 2×/wk',
          data: Array(10081).fill(apc2),
          borderColor: 'rgba(153,102,255,1)',
          borderWidth: 1.5,
          borderDash: [8, 4],
          pointRadius: 0,
          fill: false,
          tension: 0,
          hidden: true,
          backgroundColor: 'transparent'
        },
        {
          label: 'TAC, New 2×/wk',
          data: Array(10081).fill(tac2),
          borderColor: 'rgba(153,102,255,1)',
          borderWidth: 1.5,
          borderDash: [2, 4],
          pointRadius: 0,
          fill: false,
          tension: 0,
          hidden: true,
          backgroundColor: 'transparent'
        }
      ]
    };

    // Determine Y-axis range dynamically so differences are clearer
    // Convert to mg/dL for y-axis calculation
    const allValues = [...C_V1beginold.map(v => v * 100), ...C_V1begin.map(v => v * 100), ...C_V1begin2.map(v => v * 100)];
    const minVal = Math.min(...allValues);
    const maxVal = Math.max(...allValues);
    const yMin = Math.max(0, Math.floor(minVal / 10) * 10 - 10);   // one step below rounded min, but never below 0
    const yMax = Math.ceil(maxVal / 10) * 10 + 10;    // one step above rounded max

    const options = {
  legendCallback: function(chart) {
  // datasets already in the order you want: orange, teal, purple
  const groups = [[], [], []];              // 3 columns
  chart.data.datasets.forEach((ds, i) => {
    const col = ds.borderColor.startsWith('rgb(232') ? 0  // orange
              : ds.borderColor.startsWith('rgba(75') ? 1  // teal
              : 2;                                         // purple
    groups[col].push(
      `<li data-ds-index="${i}">
         <span style="background:${ds.borderColor};border:1px solid ${ds.borderColor}"></span>
         ${ds.label}
       </li>`
    );
  });
  return `
    <ul>${groups[0].join('')}</ul>
    <ul>${groups[1].join('')}</ul>
    <ul>${groups[2].join('')}</ul>`;
  },
  responsive: true,
  layout: { padding: 0 },
  plugins: {
    title: {
      display: true,
      text: 'PUN Levels Throughout Week',
      font: {
        size: 26
      },
      color: '#000'
    },
    legend: { display: false },
    decimation: { enabled: false },
    tooltip: {
      mode: 'index',
      intersect: false,
      callbacks: {
        label: function(ctx) {
          let label = ctx.dataset.label ? ctx.dataset.label + ': ' : '';
          if (ctx.parsed.y !== null && ctx.parsed.y !== undefined) {
            label += ctx.parsed.y.toFixed(1);
          }
          return label;
        }
      }
    }
  },
  interaction: {
    mode: 'nearest',
    axis: 'x',
    intersect: false
  },
  scales: {
    x: {
      grid: {
        color: '#ddd',
        drawBorder: true,
        drawOnChartArea: true,
        drawTicks: true
      },
      ticks: {
        callback: (value) => dayOrder[Math.floor(value / 1440)],
        display: true,
        values: [0, 1440, 2880, 4320, 5760, 7200, 8640],
        maxTicksLimit: 7
      },
      min: 0,
      max: 10080,
      display: true
    },
    y: {
      display: true,
      title: {
        display: true,
        text: 'PUN (mg/dL)',
        font: {
          weight: 'bold'
        },
        color: '#000'
      },
      beginAtZero: false,
      min: yMin,
      max: yMax,
      grid: {
        color: '#ddd',
        drawBorder: true
      },
      backgroundColor: 'transparent',
      ticks: {
        color: '#000'
      }
    }
  },
  backgroundColor: 'transparent',
  maintainAspectRatio: true
  };

  Chart.defaults.color = '#000';
  Chart.defaults.font.family = "Inter";
  Chart.defaults.backgroundColor = 'transparent';
  Chart.defaults.borderColor = '#ddd';

  // HTML Legend Plugin for Chart.js v4+
  const htmlLegendPlugin = {
    id: 'htmlLegend',
    afterUpdate(chart) {
      const legendContainer = document.getElementById('chartLegend');
      if (!legendContainer) return;
      // Group datasets by color
      const groups = [[], [], []];
      chart.data.datasets.forEach((ds, i) => {
        const col = ds.borderColor.startsWith('rgb(232') ? 0 // orange
                  : ds.borderColor.startsWith('rgba(75') ? 1 // teal
                  : 2; // purple
        groups[col].push({
          index: i,
          label: ds.label,
          color: ds.borderColor,
          hidden: chart.isDatasetVisible(i) === false
        });
      });
      // Build HTML for each column
      legendContainer.innerHTML = groups.map(group =>
        `<ul>` + group.map(item =>
          `<li data-ds-index="${item.index}">
            <input type="checkbox" ${item.hidden ? '' : 'checked'} style="margin-right: 5px;">
            <span style="background:${item.color};border:1px solid ${item.color}"></span>
            ${item.label}
          </li>`
        ).join('') + `</ul>`
      ).join('');
    }
  };

  const chart = new Chart(ctx, {
    type: 'line',
    data,
    options: {
      ...options,
      plugins: {
        ...options.plugins,
        legend: { display: false }
      }
    },
    plugins: [htmlLegendPlugin]
  });

  // Remove any existing background
  canvas.style.background = 'none';
  ctx.globalCompositeOperation = 'source-over';

  // Click handler for legend
  document.getElementById('chartLegend').onclick = function(e) {
    const li = e.target.closest('li[data-ds-index]');
    if (!li) return;
    const idx = +li.dataset.dsIndex;
    const meta = chart.getDatasetMeta(idx);
    chart.setDatasetVisibility(idx, !chart.isDatasetVisible(idx));
    chart.update();
  };

  return chart;
}
