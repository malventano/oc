export default {
  id: "time-context",
  server() {
    const offStr = () => {
      const d = new Date()
      const off = -d.getTimezoneOffset()
      const sign = off >= 0 ? '+' : '-'
      const abs = Math.abs(off)
      return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
    }
    const localIso = (t) => {
      const d = new Date(t)
      const off = -d.getTimezoneOffset()
      const local = new Date(d.getTime() + off * 60000)
      const sign = off >= 0 ? '+' : '-'
      const abs = Math.abs(off)
      return `${local.toISOString().slice(0, 23)}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
    }
    return {
      'experimental.chat.system.transform': async (_input, { system }) => {
        system[0] = system[0].replace(/\n\s*Today's date: .+/, '')
      },
      'experimental.chat.messages.transform': async (_input, output) => {
        const users = output.messages.filter(m => m.info.role === 'user')
        for (const msg of users) {
          const part = msg.parts.find(p => p.type === 'text' && !p.synthetic)
          if (!part || part.text.includes('<system-reminder>')) continue
          const t = msg.info?.time?.created
          if (!t) continue
          // Use one position-independent format for ALL user messages so a message's
          // re-derived stamp is byte-identical whether it is the current ("n") or a
          // prior ("n-x") message. localIso() is already historical-DST-aware
          // (getTimezoneOffset() on the message's own instant), so it is byte-stable
          // across DST boundaries with zero DB writes. See PROMPT_ASSEMBLY_PREFIX_CACHE.md.
          part.text += `\n\n<system-reminder>${localIso(t)}</system-reminder>`
        }
      },
      'tool.execute.after': async (_input, output) => {
        if (output.output?.includes('<system-reminder>')) return
        output.output += `\n\n<system-reminder>${new Date().toISOString()}</system-reminder>`
      },
    }
  }
}
