import { describe, expect, it } from 'vitest';
import { mapStatus, mapVisibility } from './client';

describe('mapVisibility', () => {
  it('maps the documented Freshdesk levels', () => {
    expect(mapVisibility(1)).toBe('public');
    expect(mapVisibility(2)).toBe('logged_in');
    expect(mapVisibility(3)).toBe('agents_only');
    expect(mapVisibility(4)).toBe('selected_companies');
  });

  it('treats anything unrecognised as agents-only, never public', () => {
    // The whole point of not writing this as `visibility === 3 ? ... : 'public'`:
    // a level Freshdesk adds later, or a null on a malformed row, must not
    // default to publishing internal content on the open internet.
    expect(mapVisibility(undefined)).toBe('agents_only');
    expect(mapVisibility(99)).toBe('agents_only');
    expect(mapVisibility(0)).toBe('agents_only');
  });
});

describe('mapStatus', () => {
  it('treats only Freshdesk status 2 as published', () => {
    expect(mapStatus(2)).toBe('published');
    expect(mapStatus(1)).toBe('draft');
    expect(mapStatus(undefined)).toBe('draft');
    expect(mapStatus(7)).toBe('draft');
  });
});
