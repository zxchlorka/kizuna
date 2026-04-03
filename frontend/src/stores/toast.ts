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

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],

  push: (toast) => {
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
