/** Google Maps “Directions” deeplink → opens Navigation with destination pinned. */
function googleMapsDrivingDirectionsUrl(lat, lng) {
  const dest = encodeURIComponent(`${Number(lat)},${Number(lng)}`);
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
}

module.exports = { googleMapsDrivingDirectionsUrl };
