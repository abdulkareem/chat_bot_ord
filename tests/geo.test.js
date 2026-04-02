import test from 'node:test';
import assert from 'node:assert/strict';

function distanceKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = (bLat - aLat) * (Math.PI / 180);
  const dLng = (bLng - aLng) * (Math.PI / 180);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

test('distance is 0 for same point', () => {
  assert.equal(distanceKm(12.97, 77.59, 12.97, 77.59), 0);
});

test('distance Bengaluru to Mysuru is about 126km', () => {
  const km = distanceKm(12.9716, 77.5946, 12.2958, 76.6394);
  assert.ok(km > 120 && km < 140);
});
