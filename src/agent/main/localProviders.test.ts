import { describe, it, expect } from 'vitest'
import {
  normalizeBaseUrl,
  chatBaseUrl,
  parseOllamaTags,
  parseOpenAiModels,
  buildModelsJson,
} from './localProviders'
import type { LocalProviderConfig, LocalProviderStatus } from '../../shared/types'

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434')
    expect(normalizeBaseUrl('http://localhost:11434///')).toBe('http://localhost:11434')
  })
  it('strips a trailing /v1 so users can paste either form', () => {
    expect(normalizeBaseUrl('http://localhost:1234/v1')).toBe('http://localhost:1234')
    expect(normalizeBaseUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234')
  })
  it('trims whitespace', () => {
    expect(normalizeBaseUrl('  http://host:8000  ')).toBe('http://host:8000')
  })
  it('leaves a bare root untouched', () => {
    expect(normalizeBaseUrl('http://localhost:11434')).toBe('http://localhost:11434')
  })
})

describe('chatBaseUrl', () => {
  it('appends exactly one /v1 regardless of input form', () => {
    expect(chatBaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1')
    expect(chatBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1')
    expect(chatBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434/v1')
  })
})

describe('parseOllamaTags', () => {
  it('extracts model names and context length', () => {
    const payload = {
      models: [
        { name: 'llama3.1:8b', details: { context_length: 131072 } },
        { name: 'qwen2.5-coder:7b' },
      ],
    }
    expect(parseOllamaTags(payload)).toEqual([
      { id: 'llama3.1:8b', name: 'llama3.1:8b', contextWindow: 131072 },
      { id: 'qwen2.5-coder:7b', name: 'qwen2.5-coder:7b', contextWindow: undefined },
    ])
  })
  it('falls back to the `model` field when `name` is absent', () => {
    expect(parseOllamaTags({ models: [{ model: 'phi3:mini' }] })).toEqual([
      { id: 'phi3:mini', name: 'phi3:mini', contextWindow: undefined },
    ])
  })
  it('is defensive against junk payloads', () => {
    expect(parseOllamaTags(null)).toEqual([])
    expect(parseOllamaTags({})).toEqual([])
    expect(parseOllamaTags({ models: 'nope' })).toEqual([])
    expect(parseOllamaTags({ models: [{}, { name: 42 }] })).toEqual([])
  })
})

describe('parseOpenAiModels', () => {
  it('extracts ids from an OpenAI /v1/models payload', () => {
    const payload = { data: [{ id: 'qwen2.5-7b-instruct' }, { id: 'mistral-7b' }] }
    expect(parseOpenAiModels(payload)).toEqual([
      { id: 'qwen2.5-7b-instruct', name: 'qwen2.5-7b-instruct' },
      { id: 'mistral-7b', name: 'mistral-7b' },
    ])
  })
  it('is defensive against junk payloads', () => {
    expect(parseOpenAiModels(null)).toEqual([])
    expect(parseOpenAiModels({ data: [{}, { id: 5 }] })).toEqual([])
  })
})

describe('buildModelsJson', () => {
  const ollama: LocalProviderConfig = {
    id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', enabled: true, builtin: true,
  }
  const lmstudio: LocalProviderConfig = {
    id: 'lmstudio', name: 'LM Studio', kind: 'openai', baseUrl: 'http://localhost:1234/v1', enabled: true, builtin: true,
  }

  it('emits a pi provider entry with /v1 base and zero-cost models', () => {
    const statuses = new Map<string, LocalProviderStatus>([
      ['ollama', { id: 'ollama', reachable: true, models: [{ id: 'llama3.1:8b', name: 'llama3.1:8b', contextWindow: 131072 }] }],
    ])
    const out = buildModelsJson([ollama], statuses)
    expect(out.providers.ollama.baseUrl).toBe('http://localhost:11434/v1')
    expect(out.providers.ollama.api).toBe('openai-completions')
    expect(out.providers.ollama.compat).toEqual({ supportsDeveloperRole: false, supportsReasoningEffort: false })
    expect(out.providers.ollama.models[0]).toMatchObject({
      id: 'llama3.1:8b',
      contextWindow: 131072,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
  })

  it('normalises a baseUrl that already includes /v1', () => {
    const statuses = new Map<string, LocalProviderStatus>([
      ['lmstudio', { id: 'lmstudio', reachable: true, models: [{ id: 'm' }] }],
    ])
    const out = buildModelsJson([lmstudio], statuses)
    expect(out.providers.lmstudio.baseUrl).toBe('http://localhost:1234/v1')
  })

  it('applies a default context window when none is advertised', () => {
    const statuses = new Map<string, LocalProviderStatus>([
      ['lmstudio', { id: 'lmstudio', reachable: true, models: [{ id: 'm' }] }],
    ])
    const out = buildModelsJson([lmstudio], statuses)
    expect(out.providers.lmstudio.models[0].contextWindow).toBe(8192)
  })

  it('omits disabled, unreachable, and empty providers', () => {
    const statuses = new Map<string, LocalProviderStatus>([
      ['ollama', { id: 'ollama', reachable: false, models: [], error: 'ECONNREFUSED' }],
      ['lmstudio', { id: 'lmstudio', reachable: true, models: [] }],
    ])
    const disabled: LocalProviderConfig = { ...ollama, id: 'vllm', name: 'vLLM', enabled: false }
    const out = buildModelsJson([ollama, lmstudio, disabled], statuses)
    expect(Object.keys(out.providers)).toEqual([])
  })
})
