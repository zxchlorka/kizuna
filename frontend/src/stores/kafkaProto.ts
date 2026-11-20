import { apiFetch, throwOnApiError } from '@/lib/http'

// The .proto contract attached to a topic: binary values in it are read as
// `message` and arrive as JSON with format 'protobuf'.
export interface TopicProto {
  file_name: string
  message: string
  // Every message type in the file, full names in declaration order.
  messages: string[]
}

function protoUrl(connId: string, topic: string): string {
  return `/api/connections/${connId}/objects/${encodeURIComponent(topic)}/proto`
}

export async function fetchTopicProto(connId: string, topic: string): Promise<TopicProto | null> {
  const res = await apiFetch(protoUrl(connId, topic))
  await throwOnApiError(res)
  return (await res.json()) as TopicProto | null
}

// Attaches a file (with its likely top-level message unless one is named), or,
// with no source, switches the message of the file already attached.
export async function saveTopicProto(
  connId: string,
  topic: string,
  body: { file_name?: string; source?: string; message?: string }
): Promise<TopicProto> {
  const res = await apiFetch(protoUrl(connId, topic), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await throwOnApiError(res)
  return (await res.json()) as TopicProto
}

export async function removeTopicProto(connId: string, topic: string): Promise<void> {
  const res = await apiFetch(protoUrl(connId, topic), { method: 'DELETE' })
  await throwOnApiError(res)
}

// The message name without its package, as the topic header shows it.
export function shortMessageName(fullName: string): string {
  return fullName.slice(fullName.lastIndexOf('.') + 1)
}
