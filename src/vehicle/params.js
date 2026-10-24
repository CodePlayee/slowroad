// src/vehicle/params.js — TUNABLES for the car and autodrive. Owned by the JOURNEY builder.
export const VEHICLE = {
  bodyLength: 4.79,
  bodyWidth: 1.982,
  wheelRadius: 0.36,
  wheelWidth: 0.28,
  wheelbase: 2.89,
  trackWidth: 1.63,
  rideHeight: 0.145,

  bodyColor: 0xe9edf0,
  glassColor: 0x101820,
  tyreColor: 0x14161a,
  rimColor: 0x59636d,

  laneOffset: 1.72,      // metres right of the centreline (drive on the right)
  cruiseKph: 88,
  maxKph: 108,
  minKph: 42,
  latAccel: 3.1,         // m/s^2 comfort limit -> slows for corners
  accel: 3.2,
  brake: 5.0,
  headlightsFrom: 0.06,  // dayness below this -> lights on
};
