import { describe, expect, test } from '@jest/globals';
import { getPushCopy } from '../catalog';

describe('localized push copy', () => {
  test('interpolates English event details', () => {
    expect(getPushCopy('en', 'van_near', { childName: 'Asha', eta: 4 })).toEqual({ title: 'Van is nearby', body: 'The van is about 4 minutes from Asha’s stop.' });
  });

  test('uses Hindi copy for the stored Hindi language', () => {
    expect(getPushCopy('hi', 'picked_up', { childName: 'आशा' }).body).toContain('आशा');
  });
});
