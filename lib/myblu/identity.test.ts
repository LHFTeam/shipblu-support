import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { parseClaim, parseInstallId, resolveIdentity, signedClaim, verifyClaim } from './identity';
import { readProfile, subjectFor } from './platform';

const SECRET = 'a-secret-long-enough-to-be-real-0123456789';

/**
 * `env()` validates the whole schema, so a module reading one optional value
 * still needs the required ones present. The widget's identity tests take the
 * same approach for the same reason.
 */
const ORIGINAL = process.env;

function withEnv(extra: Record<string, string> = {}) {
  process.env = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost:5432/test',
    APP_SECRET: '0'.repeat(64),
    ...extra,
  } as NodeJS.ProcessEnv;
  resetEnvCache();
}

beforeEach(() => withEnv());

afterEach(() => {
  process.env = ORIGINAL;
  resetEnvCache();
});

function sign(value: string): string {
  return createHmac('sha256', SECRET).update(value).digest('hex');
}

const NO_PROFILE = { phone: null, email: null, name: null };

describe('what the delivery platform returned', () => {
  it('recognises a phone under any of the names the platform might use', () => {
    // This is the single most consequential unknown in the whole integration
    // and it cannot be observed without a real token: myBlu's own DTO for this
    // endpoint names only email and the two name halves, and a non-strict zod
    // object *strips* what it does not name — so the platform may well be
    // sending a phone that nobody has ever seen. Reading the wrong key is
    // indistinguishable from the platform sending nothing: both produce an
    // unverified session, silently, for every user.
    for (const key of ['phone', 'phone_number', 'mobile', 'customer_phone']) {
      const read = readProfile({ [key]: '+20 100 123 4567' });
      expect(read.profile.phone, key).toBe('201001234567');
      expect(read.subject, key).toBe('phone:201001234567');
    }
  });

  it('treats a missing phone as an answer rather than an error', () => {
    // The device-scoped path. A token can be perfectly live and name a customer
    // whose profile carries nothing identifying.
    const read = readProfile({ first_name: 'Nour', last_name: 'Adel' });
    expect(read.profile.name).toBe('Nour Adel');
    expect(read.profile.phone).toBeNull();
    expect(read.subject).toBeNull();
  });

  it('falls back to the email only when there is no phone', () => {
    expect(readProfile({ email: 'A@Example.com ' }).subject).toBe('email:a@example.com');
    expect(readProfile({ email: 'a@example.com', phone: '201001234567' }).subject).toBe(
      'phone:201001234567',
    );
  });

  it('refuses a value too short to be a number', () => {
    // A four-digit extension pasted into a phone field would otherwise become a
    // subject, and every customer whose profile carried the same one would
    // resolve onto a single shared contact.
    expect(readProfile({ phone: '1234' }).profile.phone).toBeNull();
    expect(readProfile({ phone: '1234' }).subject).toBeNull();
  });

  it('survives a body that is not the shape we expect', () => {
    expect(readProfile(null).subject).toBeNull();
    expect(readProfile('maintenance').subject).toBeNull();
    expect(readProfile([1, 2, 3]).subject).toBeNull();
  });
});

describe('the app claim', () => {
  it('joins a first and last name, and normalises the contactable fields', () => {
    const claim = parseClaim({
      firstName: ' Nour ',
      lastName: 'Adel',
      email: '  NOUR@Example.com ',
      phone: '+20 (100) 123-4567',
    });

    expect(claim).toEqual({
      name: 'Nour Adel',
      email: 'nour@example.com',
      phone: '201001234567',
    });
  });

  it('drops a value that is not usable rather than passing it through', () => {
    const claim = parseClaim({ email: 'not-an-address', phone: '12' });
    expect(claim.email).toBeNull();
    expect(claim.phone).toBeNull();
  });
});

describe('the install id', () => {
  it('refuses anything too short to be a device', () => {
    // This is what a device-scoped session is filed under. A short or empty
    // value would put every app that sent one onto a single shared contact —
    // one contact holding many strangers' support histories.
    expect(parseInstallId('')).toBeNull();
    expect(parseInstallId('abc')).toBeNull();
    expect(parseInstallId('0123456789abcde')).toBeNull();
    expect(parseInstallId('0123456789abcdef')).toBe('0123456789abcdef');
  });

  it('accepts a UUID and refuses something carrying separators we key on', () => {
    expect(parseInstallId('3f7a1c84-2b19-4f6e-9a0d-1e2f3a4b5c6d')).toBe(
      '3f7a1c84-2b19-4f6e-9a0d-1e2f3a4b5c6d',
    );
    expect(parseInstallId('3f7a1c84 2b19 4f6e 9a0d 1e2f3a4b5c6d')).toBeNull();
  });
});

describe('the signature', () => {
  const claim = { name: 'Nour', email: 'nour@example.com', phone: '201001234567' };

  beforeEach(() => withEnv({ MOBILE_IDENTITY_SECRET: SECRET }));

  it('covers the identifying half only, phone before email', () => {
    // Documented in docs/myblu-support-api.md, so a change here breaks a
    // deployed integration silently. Name is decoration: covering it would mean
    // a customer editing their profile stops being identified at all.
    expect(signedClaim(claim)).toBe('201001234567|nour@example.com');
    expect(signedClaim({ ...claim, name: 'Somebody Else' })).toBe(signedClaim(claim));
  });

  it('keeps empty fields as their own side of the separator', () => {
    expect(signedClaim({ name: null, email: null, phone: '201001234567' })).toBe('201001234567|');
    expect(signedClaim({ name: null, email: 'a@b.co', phone: null })).toBe('|a@b.co');
  });

  it('verifies a signature the platform would have produced', () => {
    expect(verifyClaim(claim, sign(signedClaim(claim)))).toBe(true);
    expect(verifyClaim(claim, sign('201001234567|someone@else.com'))).toBe(false);
    expect(verifyClaim(claim, 'not-hex')).toBe(false);
    expect(verifyClaim(claim, undefined)).toBe(false);
  });

  it('accepts the signature whatever case it arrives in', () => {
    expect(verifyClaim(claim, sign(signedClaim(claim)).toUpperCase())).toBe(true);
  });

  it('believes nothing while no secret is configured', () => {
    withEnv();
    // An integration that has not been given a secret cannot be producing real
    // signatures, so treating an unverifiable one as valid would make the whole
    // mechanism decorative.
    expect(verifyClaim(claim, sign(signedClaim(claim)))).toBe(false);
  });
});

describe('resolving who the handshake is for', () => {
  const claim = { name: 'Nour', email: 'nour@example.com', phone: '201001234567' };

  it("takes the platform's answer over the app's claim", () => {
    const resolved = resolveIdentity({
      profile: { phone: '201009999999', email: 'real@example.com', name: 'Real Name' },
      subject: 'phone:201009999999',
      claim,
      signatureVerified: false,
    });

    expect(resolved.verified).toBe(true);
    expect(resolved.phone).toBe('201009999999');
    expect(resolved.subject).toBe('phone:201009999999');
  });

  it('never lets an unsigned claim become a subject', () => {
    // The whole security of this module. The bearer proves "some live myBlu
    // user"; the phone claims "this one", and nothing links them — so believing
    // the pair would let any myBlu user read any Egyptian mobile's support
    // history. A null subject is what routes this to a device-scoped contact.
    const resolved = resolveIdentity({
      profile: NO_PROFILE,
      subject: null,
      claim,
      signatureVerified: false,
    });

    expect(resolved.subject).toBeNull();
    expect(resolved.verified).toBe(false);
    // The claim still travels: it decorates the contact, and the phone is what
    // makes the person findable as a merge candidate.
    expect(resolved.phone).toBe('201001234567');
    expect(resolved.name).toBe('Nour');
  });

  it('promotes a claim the platform signed', () => {
    const resolved = resolveIdentity({
      profile: NO_PROFILE,
      subject: null,
      claim,
      signatureVerified: true,
    });

    expect(resolved.verified).toBe(true);
    expect(resolved.subject).toBe(subjectFor(claim.phone, claim.email));
  });

  it('does not promote a signed claim that identifies nobody', () => {
    // A signature over `|` verifies perfectly well and says nothing. Without
    // this, an integration sending an empty identity with a valid signature
    // would produce a "verified" session with no subject to verify.
    const empty = { name: 'Nour', email: null, phone: null };
    const resolved = resolveIdentity({
      profile: NO_PROFILE,
      subject: null,
      claim: empty,
      signatureVerified: true,
    });

    expect(resolved.subject).toBeNull();
    expect(resolved.verified).toBe(false);
  });
});
