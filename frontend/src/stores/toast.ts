import { create } from 'zustand'

type ToastTone = 'success' | 'error' | 'info'

export interface ToastItem {
  id: string
  title: string
  message?: string
  tone: ToastTone
}

interface ToastStore {
  toasts: ToastItem[]
  push: (toast: Omit<ToastItem, 'id'>) => void
  dismiss: (id: string) => void
}

const TOAST_DEDUPE_MS = 4_000
const recentToasts = new Map<string, number>()

function toastSignature(toast: Omit<ToastItem, 'id'>): string {
  return `${toast.tone}:${toast.title}:${toast.message ?? ''}`
}

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],

  push: (toast) => {
    const signature = toastSignature(toast)
    const now = Date.now()
    const lastShownAt = recentToasts.get(signature)
    if (lastShownAt && now - lastShownAt < TOAST_DEDUPE_MS) {
      return
    }
    recentToasts.set(signature, now)

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }))

    window.setTimeout(() => {
      get().dismiss(id)
    }, 3200)
  },

  dismiss: (id) => {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
  },
}))
