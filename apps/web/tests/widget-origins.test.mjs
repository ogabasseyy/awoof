import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDisclosureOrigins } from '../src/lib/widget-origins.ts';

test('dashboard save keeps a stored custom-port origin and adds the promised standard origin', () => {
    assert.deepEqual(
        resolveDisclosureOrigins(['shop.example.com'], ['https://shop.example.com:8443']),
        ['https://shop.example.com:8443', 'https://shop.example.com'],
    );
});

test('dashboard save drops stored origins whose hostname was removed', () => {
    assert.deepEqual(
        resolveDisclosureOrigins(['shop.example.com'], ['https://shop.example.com:8443', 'https://old.example.com']),
        ['https://shop.example.com:8443', 'https://shop.example.com'],
    );
});

test('dashboard save derives standard origins when nothing is stored', () => {
    assert.deepEqual(resolveDisclosureOrigins(['shop.example.com'], undefined), ['https://shop.example.com']);
    assert.deepEqual(resolveDisclosureOrigins(['Shop.Example.com'], []), ['https://shop.example.com']);
});

test('dashboard save drops stored entries that cannot match enforcement', () => {
    assert.deepEqual(
        resolveDisclosureOrigins(['shop.example.com'], ['not-a-url', 42, 'https://shop.example.com:8443']),
        ['https://shop.example.com:8443', 'https://shop.example.com'],
    );
});

test('dashboard save does not duplicate an already stored standard origin', () => {
    assert.deepEqual(
        resolveDisclosureOrigins(['shop.example.com'], ['https://shop.example.com']),
        ['https://shop.example.com'],
    );
});
