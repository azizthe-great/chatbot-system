'use strict';

const STATUS_LIFECYCLE = Object.freeze([
  'purchase_confirmed', 'export_processing', 'awaiting_vessel', 'departed',
  'in_transit', 'arrived_destination', 'customs_clearance', 'released_delivered'
]);
const STATUS_LABELS = Object.freeze({
  purchase_confirmed: 'Purchase confirmed', export_processing: 'Export processing', awaiting_vessel: 'Awaiting vessel',
  departed: 'Departed', in_transit: 'In transit', arrived_destination: 'Arrived at destination',
  customs_clearance: 'Customs clearance', released_delivered: 'Released / delivered'
});
const MAX_DATE = '9999-12-31';

class ShipmentInputError extends Error {
  constructor(message) { super(message); this.name = 'ShipmentInputError'; this.statusCode = 400; }
}

function cleanOptional(value, label, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) throw new ShipmentInputError(`${label} must be a non-empty string of at most ${maxLength} characters.`);
  return value.trim();
}

function validateDate(value, label, { allowPast = true, allowFuture = true } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value || value > MAX_DATE) {
    throw new ShipmentInputError(`${label} must be a valid YYYY-MM-DD date.`);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (!allowPast && value < today) throw new ShipmentInputError(`${label} cannot be in the past.`);
  if (!allowFuture && value > today) throw new ShipmentInputError(`${label} cannot be in the future.`);
  return value;
}

function validateOccurredAt(value) {
  if (value === undefined || value === null || value === '') return new Date();
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new ShipmentInputError('Milestone timestamp must be a valid ISO 8601 timestamp.');
  const date = new Date(value);
  if (date.getTime() > Date.now()) throw new ShipmentInputError('A recorded milestone cannot be in the future.');
  return date;
}

function validateCreateShipment(body) {
  const originPort = cleanOptional(body.originPort, 'Origin port', 120);
  const destinationPort = cleanOptional(body.destinationPort, 'Destination port', 120);
  if (!originPort || !destinationPort) throw new ShipmentInputError('Origin and destination ports are required.');
  const departureDate = validateDate(body.departureDate, 'Departure date');
  const estimatedArrivalDate = validateDate(body.estimatedArrivalDate, 'Estimated arrival date', { allowPast: false });
  if (departureDate && estimatedArrivalDate && departureDate > estimatedArrivalDate) throw new ShipmentInputError('Estimated arrival date must be on or after departure date.');
  const status = body.status || STATUS_LIFECYCLE[0];
  if (!STATUS_LIFECYCLE.includes(status)) throw new ShipmentInputError('Shipment status is not supported.');
  if (status !== STATUS_LIFECYCLE[0]) throw new ShipmentInputError('A new shipment must start at Purchase confirmed; append later milestones in lifecycle order.');
  return {
    customerId: body.customerId, vehicleId: body.vehicleId || null, enquiryId: body.enquiryId || null,
    carrier: cleanOptional(body.carrier, 'Carrier', 120), originPort, destinationPort,
    departureDate, estimatedArrivalDate, status
  };
}

function validateShipmentPatch(body) {
  const result = {};
  for (const key of ['carrier', 'originPort', 'destinationPort']) {
    if (Object.hasOwn(body, key)) {
      const value = cleanOptional(body[key], key === 'carrier' ? 'Carrier' : key === 'originPort' ? 'Origin port' : 'Destination port', 120);
      if (key !== 'carrier' && !value) throw new ShipmentInputError(`${key} cannot be blank.`);
      result[key] = value;
    }
  }
  if (Object.hasOwn(body, 'departureDate')) result.departureDate = validateDate(body.departureDate, 'Departure date');
  if (Object.hasOwn(body, 'estimatedArrivalDate')) result.estimatedArrivalDate = validateDate(body.estimatedArrivalDate, 'Estimated arrival date');
  if (!Object.keys(result).length && !Object.hasOwn(body, 'status')) throw new ShipmentInputError('Provide shipment fields to update.');
  return result;
}

function nextStatus(current, requested) {
  if (!STATUS_LIFECYCLE.includes(requested)) throw new ShipmentInputError('Shipment status is not supported.');
  if (requested === current) throw new ShipmentInputError('Shipment is already at that milestone.');
  const currentIndex = STATUS_LIFECYCLE.indexOf(current);
  if (STATUS_LIFECYCLE[currentIndex + 1] !== requested) throw new ShipmentInputError('Shipment status must advance exactly one step in the documented lifecycle.');
}

module.exports = { STATUS_LIFECYCLE, STATUS_LABELS, ShipmentInputError, cleanOptional, validateDate, validateOccurredAt, validateCreateShipment, validateShipmentPatch, nextStatus };
