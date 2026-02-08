/* controller.js  ─ ES-module that coordinates UI, calculations & chart */
// Dynamic import to avoid circular dependency with graph.js

/* ─────────── UI VISIBILITY + VALIDATION ─────────── */
function checkInputs() {
    const requiredInputs = [...document.querySelectorAll('input[required]')];
    
    // Group radio buttons by name
    const radioGroups = {};
    const otherInputs = [];
    
    requiredInputs.forEach(input => {
        if (input.type === 'radio') {
            if (!radioGroups[input.name]) {
                radioGroups[input.name] = [];
            }
            radioGroups[input.name].push(input);
        } else {
            otherInputs.push(input);
        }
    });
    
    // Check if all non-radio required inputs have values
    const allOthersFilled = otherInputs.every(i => i.value && i.value.trim() !== '');
    
    // Check if at least one radio in each required group is checked
    const allRadioGroupsChecked = Object.values(radioGroups).every(group => 
        group.some(radio => radio.checked)
    );
    
    document.getElementById('calculate').disabled = !(allOthersFilled && allRadioGroupsChecked);
}

/* ─────────── GENERIC HELPERS (exported so graph.js can import them) ─────────── */
export const getNumberValue = (id) => {
    const n = parseFloat(document.getElementById(id)?.value);
    return Number.isFinite(n) ? n : 0;
};

export function calculateVolumeOfPatient() {
    const ureaDisplay = document.getElementById('ureaDisplay');
    const manualVolume = getNumberValue('ureaDistribution');

    // Always calculate from demographics for display (reference) purposes
    const age = getNumberValue('age');
    const height = getNumberValue('height');
    const weight = getNumberValue('weight');
    const gender = document.querySelector('input[name="gender"]:checked')?.value;

    // Check if all demographic inputs are filled
    if (age > 0 && height > 0 && weight > 0 && gender) {
        const demographicVolume = gender === 'male'
            ? 2.447 - 0.09156 * age + 0.1074 * height + 0.3362 * weight
            : -2.097 + 0.1069 * height + 0.2466 * weight;
        const adjustedVolume = demographicVolume * 0.9;
        
        // Always display the demographic calculation when available (for reference)
        ureaDisplay.value = adjustedVolume.toFixed(2);
    } else {
        // Clear display if demographics not complete
        ureaDisplay.value = '';
    }

    // Always use manual volume for calculations (required field)
    return manualVolume;
}

export function calculateTwice() {
    let spKtV = getNumberValue("spKtV_current");
    let time = getNumberValue("time");
    let weeklyuf = getNumberValue("weeklyuf");
    let kru = getNumberValue("kru");
    let stdKtV_target = getNumberValue("stdKtV_target")
    let weight = getNumberValue("weight");
    let ureaVolume = calculateVolumeOfPatient();
    let t_prime = time; // start with current dialysis time
    let iteration_step = 0.1;
    let spKtV_prime = 0;

    let eKtV = (spKtV * time) / (time + 30);
    let Keff = (ureaVolume * 1000 * eKtV) / time;

    let UF_factor = 1 / (1 - (0.74 * weeklyuf) / (2 * ureaVolume));
    let KruAdd = (10080 * kru) / (ureaVolume * 1000);
    let stdKtV_Leypoldt = 0; // Declare outside loop
    let stdKtV_trial = 0; // Declare outside loop to save final value

    let difference = 1;
    while (difference > 0.001 * stdKtV_target) {
        spKtV_prime = (Keff * (t_prime + 30)) / (ureaVolume * 1000);
        let eKtV_prime = (spKtV_prime * t_prime) / (t_prime + 30);
        let a = 1 - Math.exp(-eKtV_prime);
        stdKtV_Leypoldt = (10080 * a / t_prime) / (a / eKtV_prime + (10080 / (2 * t_prime)) - 1);
        stdKtV_trial = UF_factor * stdKtV_Leypoldt + KruAdd;
        difference = Math.abs(stdKtV_trial - stdKtV_target);

        // adjust time for next iteration
        if (stdKtV_trial < stdKtV_target) {
            t_prime += iteration_step;
        } else {
            t_prime -= iteration_step;
        }
    }

    let t_target = Math.round(t_prime);

    // removal rate
    let weightGainPerDay = weeklyuf / 7;
    let weightAccumulation = weightGainPerDay * 4 * 1000;
    let removalRate = weightAccumulation / (t_target / 60 * weight);
    let newstdKtVTwiceValue = stdKtV_trial; // Use the converged value
    let timeOutputTwice = document.getElementById("timeOutputTwice");
    if (timeOutputTwice) {
        timeOutputTwice.textContent = `${t_target}` + " min";
    }

    let UF_RateTwice = document.getElementById("UF_RateTwice");
    if (UF_RateTwice) {
        UF_RateTwice.textContent = `${removalRate.toFixed(1)}` + " mL/kg/hr";
    }

    let newspKtVTwice = document.getElementById("newspKtVTwice");
    if (newspKtVTwice) {
        newspKtVTwice.textContent = `${spKtV_prime.toFixed(2)}`;
    }
    let newstdKtVTwice = document.getElementById("newstdKtVTwice");
    if (newstdKtVTwice) {
        newstdKtVTwice.textContent = `${newstdKtVTwiceValue.toFixed(2)}`;
    }

    if (removalRate < 13) {
        let UF_WarningTwice = document.getElementById("UF_WarningTwice");
        if (UF_WarningTwice) {
            UF_WarningTwice.textContent = "";
        }
    } else {
        let t_target13 = Math.round((60 * weightAccumulation) / (weight * 13));
        let UF_WarningTwice = document.getElementById("UF_WarningTwice");
        if (UF_WarningTwice) {
            UF_WarningTwice.innerHTML = "<strong>NOTE🚨</strong>: The predicted UF rate is greater than 13 mL/kg/hr. Increasing time to " + `${t_target13}` + " minutes would reduce the UF rate to 13 mL/kg/hr.";
        }
    }
    return t_target
}

export function calculateThrice() {
    let spKtV = getNumberValue("spKtV_current");
    let time = getNumberValue("time");
    let weeklyuf = getNumberValue("weeklyuf");
    let kru = getNumberValue("kru");
    let stdKtV_target = getNumberValue("stdKtV_target")
    let weight = getNumberValue("weight");
    let ureaVolume = calculateVolumeOfPatient();
    let t_prime = time; // start with current dialysis time
    let iteration_step = 0.1;
    let spKtV_prime = 0;

    let eKtV = (spKtV * time) / (time + 30);
    let Keff = (ureaVolume * 1000 * eKtV) / time;

    let UF_factor = 1 / (1 - (0.74 * weeklyuf) / (3 * ureaVolume));
    let KruAdd = (10080 * kru) / (ureaVolume * 1000);
    let stdKtV_Leypoldt = 0; // Declare outside loop
    let stdKtV_trial = 0; // Declare outside loop to save final value

    let difference = 1;
    while (difference > 0.001 * stdKtV_target) {
        spKtV_prime = (Keff * (t_prime + 30)) / (ureaVolume * 1000);
        let eKtV_prime = (spKtV_prime * t_prime) / (t_prime + 30);
        let a = 1 - Math.exp(-eKtV_prime);
        stdKtV_Leypoldt = (10080 * a / t_prime) / (a / eKtV_prime + (10080 / (3 * t_prime)) - 1);
        stdKtV_trial = UF_factor * stdKtV_Leypoldt + KruAdd;
        difference = Math.abs(stdKtV_trial - stdKtV_target);

        // adjust time for next iteration
        if (stdKtV_trial < stdKtV_target) {
            t_prime += iteration_step;
        } else {
            t_prime -= iteration_step;
        }
    }

    let t_target = Math.round(t_prime);

    // removal rate
    let weightGainPerDay = weeklyuf / 7;
    let weightAccumulation = weightGainPerDay * 3 * 1000;
    let removalRate = weightAccumulation / (t_target / 60 * weight);
    let newstdKtVThriceValue = stdKtV_trial; // Use the converged value
    let timeOutputThrice = document.getElementById("timeOutputThrice");
    if (timeOutputThrice) {
        timeOutputThrice.textContent = `${t_target}` + " min";
    }

    let UF_RateThrice = document.getElementById("UF_RateThrice");
    if (UF_RateThrice) {
        UF_RateThrice.textContent = `${removalRate.toFixed(1)}` + " mL/kg/hr";
    }

    let newspKtVThrice = document.getElementById("newspKtVThrice");
    if (newspKtVThrice) {
        newspKtVThrice.textContent = `${spKtV_prime.toFixed(2)}`;
    }
    let newstdKtVThrice = document.getElementById("newstdKtVThrice");
    if (newstdKtVThrice) {
        newstdKtVThrice.textContent = `${newstdKtVThriceValue.toFixed(2)}`;
    }
    if (removalRate < 13) {
        let UF_WarningThrice = document.getElementById("UF_WarningThrice");
        if (UF_WarningThrice) {
            UF_WarningThrice.textContent = "";
        }
    } else {
        let t_target13 = Math.round((60 * weightAccumulation) / (weight * 13));
        let UF_WarningThrice = document.getElementById("UF_WarningThrice");
        if (UF_WarningThrice) {
            UF_WarningThrice.innerHTML = "<strong>NOTE🚨</strong>: The predicted UF rate is greater than 13 mL/kg/hr. Increasing time to " + `${t_target13}` + " minutes would reduce the UF rate to 13 mL/kg/hr.";
        }
    }
    return t_target;
}

/* ─────────── INITIAL UI BINDINGS ─────────── */
document.querySelectorAll('input').forEach(i => i.addEventListener('input', checkInputs));

/* ─────────── MAIN SUBMIT HANDLER (re-draw chart each time) ─────────── */
const form = document.getElementById('dialysisForm');
let activeChart = null;

function calculateKd() {
    const spKtV = getNumberValue("spKtV_current");
    const time = getNumberValue("time");
    const Kru = getNumberValue("kru");
    const Vtotal = calculateVolumeOfPatient() * 1000; // Convert L to mL

    if (Vtotal > 0 && time > 0) {
        const Kd = (spKtV * Vtotal / time) - Kru;
        const kdOutput = document.getElementById("kdOutput");
        if (kdOutput) {
            kdOutput.textContent = `${Kd.toFixed(1)} mL/min`;
        }
    }
}

form.addEventListener('submit', async (e) => {
    e.preventDefault();          // stop page refresh

    calculateVolumeOfPatient();  // refresh derived inputs
    calculateTwice();
    calculateThrice();
    calculateKd();               // calculate and display Kd

    if (activeChart) { activeChart.destroy(); }

    // Use dynamic import to avoid circular dependency
    const { drawGraph } = await import('./graph.js');
    activeChart = drawGraph();
});

/* block Enter from jumping to next page when inside single-line input */
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault();
});

/* ─────────── VALIDATION WARNINGS ─────────── */
function checkHeightWarning() {
    const heightWarning = document.getElementById('height-warning');
    const height = getNumberValue('height');

    if (height > 0 && height < 100) {
        heightWarning.style.display = 'inline';
    } else {
        heightWarning.style.display = 'none';
    }
}

function checkAgeWarning() {
    const ageWarning = document.getElementById('age-warning');
    const age = getNumberValue('age');

    if (age > 0 && age < 18) {
        ageWarning.style.display = 'inline';
    } else {
        ageWarning.style.display = 'none';
    }
}

function checkWeightWarning() {
    const weightWarning = document.getElementById('weight-warning');
    const weight = getNumberValue('weight');

    if (weight > 0 && weight < 30) {
        weightWarning.style.display = 'inline';
    } else {
        weightWarning.style.display = 'none';
    }
}

// Add event listeners to inputs
const heightInput = document.getElementById('height');
if (heightInput) {
    heightInput.addEventListener('input', () => {
        checkHeightWarning();
        calculateVolumeOfPatient();
    });
}

const ageInput = document.getElementById('age');
if (ageInput) {
    ageInput.addEventListener('input', () => {
        checkAgeWarning();
        calculateVolumeOfPatient();
    });
}

const weightInput = document.getElementById('weight');
if (weightInput) {
    weightInput.addEventListener('input', () => {
        checkWeightWarning();
        calculateVolumeOfPatient();
    });
}

// Also add listener to gender radio buttons
const genderInputs = document.querySelectorAll('input[name="gender"]');
genderInputs.forEach(input => {
    input.addEventListener('change', calculateVolumeOfPatient);
});

/* ─────────── INITIAL EMPTY CHART ─────────── */
function createEmptyChart() {
    const canvas = document.getElementById('myLineChart');
    const ctx = canvas.getContext('2d');

    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    const emptyData = {
        labels: Array.from({ length: 10081 }, (_, i) => i),
        datasets: [
            {
                label: 'Current 3×/wk',
                data: [],
                fill: false,
                tension: 0.1,
                borderColor: 'rgb(232, 173, 96)',
                borderWidth: 1,
                pointRadius: 0,
                backgroundColor: 'transparent'
            },
            {
                label: 'New 3×/wk',
                data: [],
                fill: false,
                tension: 0.1,
                borderColor: 'rgba(75,192,192,1)',
                borderWidth: 1,
                pointRadius: 0,
                backgroundColor: 'transparent'
            },
            {
                label: 'New 2×/wk',
                data: [],
                fill: false,
                tension: 0.1,
                borderColor: 'rgba(153,102,255,1)',
                borderWidth: 1,
                pointRadius: 0,
                backgroundColor: 'transparent'
            },
            {
                label: 'APC, Current 3×/wk',
                data: [],
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
                data: [],
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
                data: [],
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
                data: [],
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
                data: [],
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
                data: [],
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

    const options = {
        responsive: true,
        layout: { padding: 0 },
        plugins: {
            title: {
                display: true,
                text: 'PUN Levels Throughout Week',
                font: { size: 26 },
                color: '#000'
            },
            legend: { display: false }
        },
        scales: {
            x: {
                grid: { color: '#ddd' },
                ticks: {
                    callback: (value) => dayOrder[Math.floor(value / 1440)],
                    values: [0, 1440, 2880, 4320, 5760, 7200, 8640],
                    maxTicksLimit: 7
                },
                min: 0,
                max: 10080
            },
            y: {
                display: true,
                title: {
                    display: true,
                    text: 'PUN (mg/dL)',
                    font: { weight: 'bold' },
                    color: '#000'
                },
                beginAtZero: true,
                min: 0,
                max: 100,
                grid: { color: '#ddd' }
            }
        },
        maintainAspectRatio: true
    };

    // HTML Legend Plugin
    const htmlLegendPlugin = {
        id: 'htmlLegend',
        afterUpdate(chart) {
            const legendContainer = document.getElementById('chartLegend');
            if (!legendContainer) return;
            const groups = [[], [], []];
            chart.data.datasets.forEach((ds, i) => {
                const col = ds.borderColor.startsWith('rgb(232') ? 0
                    : ds.borderColor.startsWith('rgba(75') ? 1
                        : 2;
                groups[col].push({
                    index: i,
                    label: ds.label,
                    color: ds.borderColor,
                    hidden: chart.isDatasetVisible(i) === false
                });
            });
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

    Chart.defaults.color = '#000';
    Chart.defaults.font.family = "Inter";
    Chart.defaults.backgroundColor = 'transparent';
    Chart.defaults.borderColor = '#ddd';

    const chart = new Chart(ctx, {
        type: 'line',
        data: emptyData,
        options: options,
        plugins: [htmlLegendPlugin]
    });

    // Click handler for legend
    document.getElementById('chartLegend').onclick = function (e) {
        const li = e.target.closest('li[data-ds-index]');
        if (!li) return;
        const idx = +li.dataset.dsIndex;
        chart.setDatasetVisibility(idx, !chart.isDatasetVisible(idx));
        chart.update();
    };

    return chart;
}

/* first-load setup */
checkInputs();
checkHeightWarning();
checkAgeWarning();
checkWeightWarning();
calculateVolumeOfPatient();  // Ensure volume display is blank on page load

/* ─────────── INITIAL EMPTY CHART ─────────── */
// Create empty chart on page load
activeChart = createEmptyChart();