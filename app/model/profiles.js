// Driving-style presets. offsetKmh applies only where the road's expected speed is ≥ 60 km/h
// (in towns the average speed is set by traffic, not by the driver).

export const PROFILES = [
  { id: 'plus5', name: '+5 km/h over the limit (default)', speedFactor: 1.0, offsetKmh: 5, maxKmh: 135, breakMinPerH: 5 },
  { id: 'limit', name: 'At the limit', speedFactor: 1.0, offsetKmh: 0, maxKmh: 130, breakMinPerH: 5 },
  { id: 'plus10', name: '+10 km/h, in a hurry', speedFactor: 1.0, offsetKmh: 10, maxKmh: 145, breakMinPerH: 3 },
  { id: 'eco', name: 'Eco: 5 km/h under, max 110', speedFactor: 1.0, offsetKmh: -5, maxKmh: 110, breakMinPerH: 6 },
];

export function profileById(id) { return PROFILES.find(p => p.id === id) || PROFILES[0]; }
