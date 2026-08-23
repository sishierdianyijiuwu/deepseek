import { describe, expect, it } from 'vitest'
import { DOCUMENT_VERSION, parseAccountDocument } from '../src/index.ts'

const file = '/tmp/account-a.json'

describe('parseAccountDocument', () => {
  it('parses refs, api-key records, and grant records', () => {
    const parsed = parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION,
      refs: { DEEPSEEK_API_KEY: 'sk' },
      records: {
        'llm-pi-ai/openai-codex': { kind: 'grant', payload: { token: 't' } },
        'llm-pi-ai/other': { kind: 'api-key', key: 'k', env: { AWS_PROFILE: 'p' } },
        'llm-pi-ai/ambient': { kind: 'api-key' },
      },
    }), file)
    expect(parsed.refs.get('DEEPSEEK_API_KEY')).toBe('sk')
    expect(parsed.records.get('llm-pi-ai/openai-codex')).toEqual({ kind: 'grant', payload: { token: 't' } })
    expect(parsed.records.get('llm-pi-ai/other')).toEqual({
      kind: 'api-key', key: 'k', env: { AWS_PROFILE: 'p' },
    })
    expect(parsed.records.get('llm-pi-ai/ambient')).toEqual({ kind: 'api-key' })
  })

  it('treats null refs and records as empty', () => {
    const parsed = parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION,
      refs: null,
      records: null,
    }), file)
    expect(parsed.refs.size).toBe(0)
    expect(parsed.records.size).toBe(0)
  })

  it('rejects invalid JSON, non-objects, unknown keys, and wrong versions', () => {
    expect(() => parseAccountDocument('{', file)).toThrow(/invalid JSON/)
    expect(() => parseAccountDocument('[]', file)).toThrow(/must be an object/)
    expect(() => parseAccountDocument('null', file)).toThrow(/must be an object/)
    expect(() => parseAccountDocument(JSON.stringify({ version: DOCUMENT_VERSION, extra: 1 }), file))
      .toThrow(/unknown top-level key/)
    expect(() => parseAccountDocument(JSON.stringify({ version: 99 }), file)).toThrow(/declares version 99/)
  })

  it('rejects malformed refs', () => {
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, refs: [],
    }), file)).toThrow(/"refs".*must be an object/)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, refs: { 'NOT-POSIX': 'x' },
    }), file)).toThrow(TypeError)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, refs: { DEEPSEEK_API_KEY: 1 },
    }), file)).toThrow(/must be a string/)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, refs: { DEEPSEEK_API_KEY: '' },
    }), file)).toThrow(/is empty/)
  })

  it('rejects malformed records', () => {
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, records: [],
    }), file)).toThrow(/"records".*must be an object/)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, records: { nope: { kind: 'api-key' } },
    }), file)).toThrow(TypeError)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, records: { 'llm-pi-ai/x': [] },
    }), file)).toThrow(/must be an object/)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, records: { 'llm-pi-ai/x': { kind: 'api-key', extra: 1 } },
    }), file)).toThrow(/unknown field/)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, records: { 'llm-pi-ai/x': { kind: 'api-key', key: '' } },
    }), file)).toThrow(/non-string or empty key/)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, records: { 'llm-pi-ai/x': { kind: 'api-key', key: 1 } },
    }), file)).toThrow(/non-string or empty key/)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, records: { 'llm-pi-ai/x': { kind: 'grant' } },
    }), file)).toThrow(/missing payload/)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, records: { 'llm-pi-ai/x': { kind: 'other' } },
    }), file)).toThrow(/unknown kind/)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, records: { 'llm-pi-ai/x': { kind: 'api-key', env: [] } },
    }), file)).toThrow(/env.*must be an object/)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, records: { 'llm-pi-ai/x': { kind: 'api-key', env: { 'NOT-POSIX': 'p' } } },
    }), file)).toThrow(TypeError)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, records: { 'llm-pi-ai/x': { kind: 'api-key', env: { AWS_PROFILE: '' } } },
    }), file)).toThrow(/must be a non-empty string/)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, records: { 'llm-pi-ai/x': { kind: 'api-key', env: { AWS_PROFILE: 1 } } },
    }), file)).toThrow(/must be a non-empty string/)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, records: { 'llm-pi-ai/x': { kind: 'api-key', env: null } },
    }), file)).toThrow(/env.*must be an object/)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, records: { 'llm-pi-ai/x': { kind: 'grant', payload: 1, extra: true } },
    }), file)).toThrow(/unknown field/)
    expect(() => parseAccountDocument(JSON.stringify({
      version: DOCUMENT_VERSION, records: { 'llm-pi-ai/x': null },
    }), file)).toThrow(/must be an object/)
  })
})
