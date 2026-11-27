import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gstProfileDefaults,
  gstRateForItem,
  gstStateCodeForName,
  gstinStateMatchesAddress,
  hasInvoiceAddress,
  isValidGstin,
  validateGstConfiguration,
  validateRecipientInvoiceDetails,
  validateTaxCode,
} from '../src/lib/domain/gst-profile.ts';

test('built-in GST profiles choose invoice document and default rates', () => {
  assert.equal(gstProfileDefaults.NOT_REGISTERED.documentType, 'RECEIPT');
  assert.equal(gstProfileDefaults.STANDARD_RESTAURANT.rateBps, 500);
  assert.equal(gstProfileDefaults.SPECIFIED_PREMISES.rateBps, 1800);
  assert.equal(gstProfileDefaults.COMPOSITION.documentType, 'BILL_OF_SUPPLY');
});

test('GST rate resolution applies inherited and per-item rates but never collects tax under non-collection profiles', () => {
  assert.equal(gstRateForItem('STANDARD_RESTAURANT', 500), 500);
  assert.equal(gstRateForItem('SPECIFIED_PREMISES', 1800, 1200), 1200);
  assert.equal(gstRateForItem('COMPOSITION', 0, 1800), 0);
  assert.equal(gstRateForItem('NOT_REGISTERED', 0, 500), 0);
  assert.throws(() => gstRateForItem('SPECIFIED_PREMISES', 10_001), /between 0 and 10000/);
});

test('registered profiles require a structural GSTIN; composition and unregistered rates stay zero', () => {
  assert.equal(isValidGstin('29ABCDE1234F1Z5'), true);
  assert.equal(isValidGstin('not-a-gstin'), false);
  assert.equal(validateGstConfiguration({ profile: 'STANDARD_RESTAURANT', rateBps: 500, gstin: '' }), 'A valid tenant GSTIN is required for the selected GST profile.');
  assert.equal(validateGstConfiguration({ profile: 'COMPOSITION', rateBps: 100, gstin: '29ABCDE1234F1Z5' }), 'This profile does not collect GST on customer bills; its bill rate must be zero.');
  assert.equal(validateGstConfiguration({ profile: 'NOT_REGISTERED', rateBps: 0, gstin: '' }), null);
});

test('invoice supplier address must contain a usable state, city, street, and Indian PIN', () => {
  assert.equal(hasInvoiceAddress({ line1: '12 Main Rd', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' }), true);
  assert.equal(hasInvoiceAddress({ line1: '12 Main Rd', city: 'Bengaluru', state: 'Karnataka', pincode: '56003' }), false);
  assert.equal(gstinStateMatchesAddress('29ABCDE1234F1Z5', 'Karnataka'), true);
  assert.equal(gstinStateMatchesAddress('27ABCDE1234F1Z5', 'Karnataka'), false);
  assert.equal(gstStateCodeForName('Karnataka'), '29');
  assert.equal(gstStateCodeForName('not a state'), null);
});

test('per-item HSN/SAC validation accepts only complete supported classifications', () => {
  assert.equal(validateTaxCode({ kind: 'HSN', code: '21069099' }), null);
  assert.equal(validateTaxCode({ kind: 'SAC', code: '996331' }), null);
  assert.match(validateTaxCode({ kind: 'SAC', code: '99633' }) ?? '', /6 digits/);
  assert.match(validateTaxCode({ kind: 'HSN', code: '21A6' }) ?? '', /digits/);
  assert.match(validateTaxCode({ kind: null, code: '2106' }) ?? '', /Select HSN or SAC/);
  assert.equal(validateTaxCode({ kind: null, code: null }), null);
});

test('recipient GST details are structurally validated and high-value B2C requires a full address', () => {
  const address = { line1: '12 Main Road', line2: '', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' };
  assert.equal(validateRecipientInvoiceDetails({ name: 'Aarav Shah', gstin: '29ABCDE1234F1Z5', address }, 100_000).error, undefined);
  assert.match(validateRecipientInvoiceDetails({ name: 'Aarav Shah', gstin: '27ABCDE1234F1Z5', address }, 100_000).error ?? '', /state does not match/);
  assert.match(validateRecipientInvoiceDetails({}, 5_000_000).error ?? '', /₹50,000/);
  assert.equal(validateRecipientInvoiceDetails({ name: 'Walk-in', address }, 5_000_000).error, undefined);
  assert.match(validateRecipientInvoiceDetails({ name: 'Walk-in', address: { ...address, state: 'Atlantis' } }, 5_000_000).error ?? '', /recognized Indian State/);
  assert.equal(validateRecipientInvoiceDetails({}, 4_999_999).error, undefined);
});
