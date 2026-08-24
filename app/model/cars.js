// Car presets. Physics constants are tuned so the energy model matches public range tests
// (see tests/unit/energy.test.mjs for the Wh/km sanity ranges).

export const CARS = [
  {
    id: 'my-2025-lr-awd',
    name: 'Model Y 2025 Long Range AWD (Giga Berlin)',
    usableKwh: 75,
    massKg: 1997,
    payloadKg: 120,
    cd: 0.22,
    areaM2: 2.5,
    crr: 0.0115,
    etaDrive: 0.90,
    etaRegen: 0.65,
    maxDcKw: 250,
    refWhKm: 180,
    curve: [[0, 120], [5, 250], [20, 250], [30, 205], [40, 170], [50, 140], [60, 115], [70, 90], [80, 65], [90, 45], [100, 15]],
  },
  {
    id: 'my-2025-lr-rwd',
    name: 'Model Y 2025 Long Range RWD',
    usableKwh: 75, massKg: 1921, payloadKg: 120, cd: 0.22, areaM2: 2.5, crr: 0.0115, etaDrive: 0.91, etaRegen: 0.65, maxDcKw: 250, refWhKm: 170,
    curve: [[0, 120], [5, 250], [20, 250], [30, 205], [40, 170], [50, 140], [60, 115], [70, 90], [80, 65], [90, 45], [100, 15]],
  },
  {
    id: 'm3-2024-lr-awd',
    name: 'Model 3 2024 Long Range AWD (Highland)',
    usableKwh: 75, massKg: 1828, payloadKg: 120, cd: 0.219, areaM2: 2.22, crr: 0.0115, etaDrive: 0.90, etaRegen: 0.65, maxDcKw: 250, refWhKm: 160,
    curve: [[0, 120], [5, 250], [20, 250], [30, 205], [40, 170], [50, 140], [60, 115], [70, 90], [80, 65], [90, 45], [100, 15]],
  },
  {
    id: 'my-2025-rwd',
    name: 'Model Y 2025 RWD (LFP 60)',
    usableKwh: 60, massKg: 1921, payloadKg: 120, cd: 0.22, areaM2: 2.5, crr: 0.0115, etaDrive: 0.91, etaRegen: 0.65, maxDcKw: 175, refWhKm: 170,
    curve: [[0, 100], [5, 175], [30, 175], [40, 150], [50, 120], [60, 100], [70, 80], [80, 60], [90, 40], [100, 15]],
  },
];

export function carById(id) { return CARS.find(c => c.id === id) || CARS[0]; }
