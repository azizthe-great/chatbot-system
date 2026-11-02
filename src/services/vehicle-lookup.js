'use strict';

class VehicleLookupError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = 'VehicleLookupError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validateVehicleIdentifier(input) {
  if (typeof input !== 'string') throw new VehicleLookupError('INVALID_IDENTIFIER', 'Enter a VIN or chassis number.', 400);
  const identifier = input.trim().toUpperCase();
  if (identifier.length < 5 || identifier.length > 40 || !/^[A-Z0-9-]+$/.test(identifier) || !/[A-Z0-9]/.test(identifier)) {
    throw new VehicleLookupError('INVALID_IDENTIFIER', 'Use a 17-character VIN or a 5–40 character chassis number containing letters, numbers, or hyphens.', 400);
  }
  const is17CharacterVinCandidate = identifier.length === 17 && /^[A-Z0-9]{17}$/.test(identifier);
  if (is17CharacterVinCandidate && !/^[A-HJ-NPR-Z0-9]{17}$/.test(identifier)) {
    throw new VehicleLookupError('INVALID_VIN', 'A 17-character VIN cannot contain I, O, or Q.', 400);
  }
  return { identifier, identifierType: is17CharacterVinCandidate ? 'vin' : 'chassis' };
}

async function lookupVehicle(input, { provider, timeoutMs = 5000 } = {}) {
  const { identifier, identifierType } = validateVehicleIdentifier(input);
  if (!provider || typeof provider.lookup !== 'function') {
    return {
      status: 'unavailable',
      reason: 'provider_not_configured',
      identifier,
      identifierType,
      provider: null,
      data: null,
      message: 'Vehicle details and history are unavailable because no vehicle data provider is configured.'
    };
  }

  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new VehicleLookupError('PROVIDER_TIMEOUT', 'The vehicle data provider timed out. Please try again later.', 504));
      }, timeoutMs);
    });
    const lookup = Promise.resolve().then(() => provider.lookup({ identifier, identifierType, signal: controller.signal }));
    const data = await Promise.race([lookup, timeout]);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid provider response');
    const providerInfo = { name: String(provider.name || 'Configured vehicle provider') };
    if (data.status === 'unavailable') {
      return { status: 'unavailable', reason: 'provider_unavailable', identifier, identifierType, provider: providerInfo, data: null, message: 'The vehicle data provider could not return a report for this lookup.' };
    }
    if (data.status === 'not_found') {
      return { status: 'not_found', identifier, identifierType, provider: providerInfo, data: null, message: 'The provider returned no matching record. Missing records do not establish that no history exists.' };
    }
    return {
      status: 'available',
      identifier,
      identifierType,
      provider: providerInfo,
      data
    };
  } catch (error) {
    if (error instanceof VehicleLookupError) throw error;
    if (error?.statusCode === 429 || error?.code === 'RATE_LIMITED') {
      throw new VehicleLookupError('PROVIDER_RATE_LIMITED', 'The vehicle data provider is rate limiting requests. Please try again later.', 429);
    }
    throw new VehicleLookupError('PROVIDER_UNAVAILABLE', 'The vehicle data provider could not complete the lookup. Please try again later.', 502);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { lookupVehicle, validateVehicleIdentifier, VehicleLookupError };
