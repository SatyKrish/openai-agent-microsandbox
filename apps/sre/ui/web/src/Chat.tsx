// Copyright 2026 openai-agent-microsandbox contributors
// SPDX-License-Identifier: Apache-2.0
//
// The conversation, on assistant-ui's primitives: messages, the composer (send, or stop the running
// turn), and the follow-up questions after a turn. Each of the agent's turns is one part, drawn by
// ./Turn. The runtime is an external store over the harness's API: the page holds the transcript,
// the harness runs the turns.

import {
  AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime,
  type AppendMessage, type ThreadMessageLike,
} from "@assistant-ui/react";
import { useEffect, useMemo, type ReactNode } from "react";

import { CardPart, Prose } from "./parts";
import { TurnPart } from "./Turn";

const PARTS = {
  Text: ({ text }: { text: string }) => <Prose text={text} />,
  data: { by_name: { turn: TurnPart as any, card: CardPart as any } },
};

function UserMessage() {
  return (
    <MessagePrimitive.Root className="ax-message user">
      <div className="ax-bubble"><MessagePrimitive.Parts components={PARTS} /></div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="ax-message assistant">
      <MessagePrimitive.Parts components={PARTS} />
    </MessagePrimitive.Root>
  );
}

export function Chat({ messages, running, placeholder, onSend, onStop, empty, footer, disabled, prefill, onPrefilled }: {
  messages: ThreadMessageLike[]; running: boolean; placeholder: string; disabled?: boolean;
  onSend: (text: string) => Promise<void>; onStop: () => Promise<void>; empty?: ReactNode; footer?: ReactNode;
  prefill?: { text: string; nonce: number } | null; onPrefilled?: () => void;
}) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>(useMemo(() => ({
    messages,
    isRunning: running,
    isDisabled: disabled,
    convertMessage: (message: ThreadMessageLike) => message,
    onNew: async (message: AppendMessage) => {
      const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n").trim();
      if (text) await onSend(text);
    },
    onCancel: onStop,
  }), [messages, running, disabled, onSend, onStop]));
  // A question put in the composer from outside (the board, an issue's card, a follow-up), to read and send.
  useEffect(() => {
    if (!prefill) return;
    runtime.thread.composer.setText(prefill.text);
    onPrefilled?.();
  }, [prefill, runtime, onPrefilled]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="ax-thread">
        <ThreadPrimitive.Viewport className="ax-viewport">
          {empty ? <ThreadPrimitive.Empty>{empty}</ThreadPrimitive.Empty> : null}
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          <div className="ax-viewport-end" />
        </ThreadPrimitive.Viewport>
        {footer}
        <ComposerPrimitive.Root className="ax-composer">
          <ComposerPrimitive.Input className="ax-composer-input" placeholder={placeholder} rows={1} autoFocus
            aria-label="Message" />
          {running ? (
            <ComposerPrimitive.Cancel className="ax-send stop" aria-label="Stop the turn">
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" /></svg>
            </ComposerPrimitive.Cancel>
          ) : (
            <ComposerPrimitive.Send className="ax-send" aria-label="Send">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
            </ComposerPrimitive.Send>
          )}
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
