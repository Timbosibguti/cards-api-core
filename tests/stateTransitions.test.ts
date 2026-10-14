/**
 * Unit tests: state transition guards (docs/state_machines.md).
 * EPIC 2 — Testing Foundation.
 */

import { describe, it, expect } from 'vitest';
import {
  isAllowedIncomingTransition,
  isAllowedOutboxTransition,
  isAllowedOutgoingTransition,
  INCOMING_ALLOWED,
  OUTBOX_ALLOWED,
  OUTGOING_ALLOWED,
} from '../src/infra/stateTransitions.js';

describe('stateTransitions', () => {
  describe('INCOMING_ALLOWED', () => {
    it('allows pending → processing', () => {
      expect(isAllowedIncomingTransition('pending', 'processing')).toBe(true);
    });
    it('allows processing → processed, failed, pending', () => {
      expect(isAllowedIncomingTransition('processing', 'processed')).toBe(true);
      expect(isAllowedIncomingTransition('processing', 'failed')).toBe(true);
      expect(isAllowedIncomingTransition('processing', 'pending')).toBe(true);
    });
    it('disallows processed → any', () => {
      expect(isAllowedIncomingTransition('processed', 'pending')).toBe(false);
      expect(isAllowedIncomingTransition('processed', 'processing')).toBe(false);
    });
    it('disallows invalid from state', () => {
      expect(isAllowedIncomingTransition('unknown', 'processing')).toBe(false);
    });
  });

  describe('OUTBOX_ALLOWED', () => {
    it('allows pending → processing', () => {
      expect(isAllowedOutboxTransition('pending', 'processing')).toBe(true);
    });
    it('allows processing → processed, failed, pending', () => {
      expect(isAllowedOutboxTransition('processing', 'processed')).toBe(true);
      expect(isAllowedOutboxTransition('processing', 'failed')).toBe(true);
    });
    it('disallows processed → any', () => {
      expect(isAllowedOutboxTransition('processed', 'pending')).toBe(false);
    });
  });

  describe('OUTGOING_ALLOWED', () => {
    it('allows pending → sending', () => {
      expect(isAllowedOutgoingTransition('pending', 'sending')).toBe(true);
    });
    it('allows sending → sent, failed, pending, rate_limited', () => {
      expect(isAllowedOutgoingTransition('sending', 'sent')).toBe(true);
      expect(isAllowedOutgoingTransition('sending', 'failed')).toBe(true);
      expect(isAllowedOutgoingTransition('sending', 'pending')).toBe(true);
      expect(isAllowedOutgoingTransition('sending', 'rate_limited')).toBe(true);
    });
    it('allows rate_limited → pending', () => {
      expect(isAllowedOutgoingTransition('rate_limited', 'pending')).toBe(true);
    });
    it('disallows sent → any', () => {
      expect(isAllowedOutgoingTransition('sent', 'pending')).toBe(false);
    });
  });

  describe('allowed maps shape', () => {
    it('INCOMING_ALLOWED has expected keys', () => {
      expect(Object.keys(INCOMING_ALLOWED).sort()).toEqual(['failed', 'pending', 'processed', 'processing']);
    });
    it('OUTBOX_ALLOWED has expected keys', () => {
      expect(Object.keys(OUTBOX_ALLOWED).sort()).toEqual(['failed', 'pending', 'processed', 'processing']);
    });
    it('OUTGOING_ALLOWED has expected keys', () => {
      expect(Object.keys(OUTGOING_ALLOWED).sort()).toEqual(['failed', 'pending', 'rate_limited', 'sending', 'sent']);
    });
  });
});
