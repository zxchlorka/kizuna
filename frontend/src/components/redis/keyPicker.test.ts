import { describe, expect, it } from 'vitest'
import { parseKeyList } from '@/components/redis/KeyPicker'

// People arrive with a list of keys already copied from somewhere: a log line,
// a terminal, a message. Each of those separates them differently, and a Redis
// key never contains whitespace — so all three separators are safe.
describe('parseKeyList', () => {
  const cases: Array<{ name: string; input: string; want: string[] }> = [
    {
      name: 'newlines, as copied from a terminal',
      input: 'profile:019ec4d4-767b\nprofile:71b0aa2f-1234\n',
      want: ['profile:019ec4d4-767b', 'profile:71b0aa2f-1234'],
    },
    {
      name: 'commas, as written in a message',
      input: 'profile:1, profile:2,profile:3',
      want: ['profile:1', 'profile:2', 'profile:3'],
    },
    { name: 'spaces', input: 'iid:a  iid:b', want: ['iid:a', 'iid:b'] },
    // A list pasted out of JSON or a shell history arrives quoted.
    { name: 'quotes are stripped', input: '"profile:1" \'profile:2\'', want: ['profile:1', 'profile:2'] },
    { name: 'a single key stays one key', input: 'profile:019ec4d4', want: ['profile:019ec4d4'] },
    { name: 'blank input yields nothing', input: '   \n  ', want: [] },
  ]

  cases.forEach(({ name, input, want }) => {
    it(name, () => expect(parseKeyList(input)).toEqual(want))
  })
})
