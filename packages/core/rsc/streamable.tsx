import type { ReactNode } from 'react';
import type OpenAI from 'openai';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

// TODO: This needs to be externalized.
import { OpenAIStream } from '../streams';

import {
  STREAMABLE_VALUE_TYPE,
  DEV_DEFAULT_STREAMABLE_WARNING_TIME,
} from './constants';
import {
  createResolvablePromise,
  createSuspensedChunk,
  consumeStream,
} from './utils';
import type { StreamableValue } from './types';

/**
 * Create a piece of changable UI that can be streamed to the client.
 * On the client side, it can be rendered as a normal React node.
 */
export function createStreamableUI(initialValue?: React.ReactNode) {
  let currentValue = initialValue;
  let closed = false;
  let { row, resolve, reject } = createSuspensedChunk(initialValue);

  function assertStream(method: string) {
    if (closed) {
      throw new Error(method + ': UI stream is already closed.');
    }
  }

  let warningTimeout: NodeJS.Timeout | undefined;
  function warnUnclosedStream() {
    if (process.env.NODE_ENV === 'development') {
      if (warningTimeout) {
        clearTimeout(warningTimeout);
      }
      warningTimeout = setTimeout(() => {
        console.warn(
          'The streamable UI has been slow to update. This may be a bug or a performance issue or you forgot to call `.done()`.',
        );
      }, DEV_DEFAULT_STREAMABLE_WARNING_TIME);
    }
  }
  warnUnclosedStream();

  return {
    value: row,
    update(value: React.ReactNode) {
      assertStream('.update()');

      // There is no need to update the value if it's referentially equal.
      if (value === currentValue) {
        warnUnclosedStream();
        return;
      }

      const resolvable = createResolvablePromise();
      currentValue = value;

      resolve({ value: currentValue, done: false, next: resolvable.promise });
      resolve = resolvable.resolve;
      reject = resolvable.reject;

      warnUnclosedStream();
    },
    append(value: React.ReactNode) {
      assertStream('.append()');

      const resolvable = createResolvablePromise();
      currentValue = value;

      resolve({ value, done: false, append: true, next: resolvable.promise });
      resolve = resolvable.resolve;
      reject = resolvable.reject;

      warnUnclosedStream();
    },
    error(error: any) {
      assertStream('.error()');

      if (warningTimeout) {
        clearTimeout(warningTimeout);
      }
      closed = true;
      reject(error);
    },
    done(...args: [] | [React.ReactNode]) {
      assertStream('.done()');

      if (warningTimeout) {
        clearTimeout(warningTimeout);
      }
      closed = true;
      if (args.length) {
        resolve({ value: args[0], done: true });
        return;
      }
      resolve({ value: currentValue, done: true });
    },
  };
}

/**
 * Create a wrapped, changable value that can be streamed to the client.
 * On the client side, the value can be accessed via the readStreamableValue() API.
 */
export function createStreamableValue<T = any, E = any>(initialValue?: T) {
  let closed = false;
  let resolvable = createResolvablePromise<StreamableValue<T, E>>();

  let currentValue = initialValue;
  let currentError: E | undefined;
  let currentPromise: typeof resolvable.promise | undefined =
    resolvable.promise;

  function assertStream(method: string) {
    if (closed) {
      throw new Error(method + ': Value stream is already closed.');
    }
  }

  let warningTimeout: NodeJS.Timeout | undefined;
  function warnUnclosedStream() {
    if (process.env.NODE_ENV === 'development') {
      if (warningTimeout) {
        clearTimeout(warningTimeout);
      }
      warningTimeout = setTimeout(() => {
        console.warn(
          'The streamable UI has been slow to update. This may be a bug or a performance issue or you forgot to call `.done()`.',
        );
      }, DEV_DEFAULT_STREAMABLE_WARNING_TIME);
    }
  }
  warnUnclosedStream();

  function createWrapped(withType?: boolean): StreamableValue<T, E> {
    // This makes the payload much smaller if there're mutative updates before the first read.
    const init: Partial<StreamableValue<T, E>> =
      currentError === undefined
        ? { curr: currentValue }
        : { error: currentError };

    if (currentPromise) {
      init.next = currentPromise;
    }

    if (withType) {
      init.type = STREAMABLE_VALUE_TYPE;
    }

    return init;
  }

  return {
    get value() {
      return createWrapped(true);
    },
    update(value: T) {
      assertStream('.update()');

      const resolvePrevious = resolvable.resolve;
      resolvable = createResolvablePromise();

      currentValue = value;
      currentPromise = resolvable.promise;
      resolvePrevious(createWrapped());

      warnUnclosedStream();
    },
    error(error: any) {
      assertStream('.error()');

      if (warningTimeout) {
        clearTimeout(warningTimeout);
      }
      closed = true;
      currentError = error;
      currentPromise = undefined;

      resolvable.resolve({ error });
    },
    done(...args: [] | [T]) {
      assertStream('.done()');

      if (warningTimeout) {
        clearTimeout(warningTimeout);
      }
      closed = true;
      currentPromise = undefined;

      if (args.length) {
        currentValue = args[0];
        resolvable.resolve({ curr: args[0] });
        return;
      }

      resolvable.resolve({});
    },
  };
}

type Streamable = ReactNode | Promise<ReactNode>;
type Renderer<T, R = Streamable> = (
  props: T,
) => R | Generator<Streamable, R, void> | AsyncGenerator<Streamable, R, void>;

type TextPayload = {
  /**
   * The full text content from the model so far.
   */
  content: string;
  /**
   * The new appended text content from the model since the last `text` call.
   */
  delta: string;
  /**
   * Whether the model is done generating text.
   * If `true`, the `content` will be the final output and this call will be the last.
   */
  done: boolean;
};

/**
 * `render` is a helper function to create a streamable UI from some LLMs.
 * Currently, it only supports OpenAI's GPT models with Function Calling and Assistants Tools.
 */
export function render<
  TS extends {
    [name: string]: z.Schema;
  } = {},
  FS extends {
    [name: string]: z.Schema;
  } = {},
>(options: {
  /**
   * The model name to use. Must be OpenAI SDK compatible. Tools and Functions are only supported
   * GPT models (3.5/4), OpenAI Assistants, Mistral small and large, and Fireworks firefunction-v1.
   *
   * @example "gpt-3.5-turbo"
   */
  model: string;
  /**
   * The provider instance to use. Currently the only provider available is OpenAI.
   * This needs to match the model name.
   */
  provider: OpenAI;
  messages: Parameters<
    typeof OpenAI.prototype.chat.completions.create
  >[0]['messages'];
  /**
   * The text renderer to use. This is a function that takes a `{ content: string, delta: string, done: boolean }`
   * payload and returns a UI node value, such as a string or a React element.
   *
   * Note: In future versions, the new `experimental_textRender` API will be replacing `text`.
   */
  text?: Renderer<TextPayload>;
  /**
   * This will replace `text` in future versions.
   */
  experimental_textRender?: Renderer<
    AsyncIterableIterator<TextPayload>,
    Streamable | void
  >;
  tools?: {
    [name in keyof TS]: {
      description?: string;
      parameters: TS[name];
      render: Renderer<z.infer<TS[name]>>;
    };
  };
  functions?: {
    [name in keyof FS]: {
      description?: string;
      parameters: FS[name];
      render: Renderer<z.infer<FS[name]>>;
    };
  };
  initial?: ReactNode;
  temperature?: number;
}): ReactNode {
  const ui = createStreamableUI(options.initial);

  const textRender = options.experimental_textRender;

  // The default text renderer just returns the content as string.
  const text = options.text
    ? options.text
    : textRender
    ? undefined
    : ({ content }: { content: string }) => content;

  if (textRender && text) {
    throw new Error(
      'You cannot use both `text` and `textRender` at the same time. Please prefer `textRender` as `text` will be deprecated in future versions.',
    );
  }

  const functions = options.functions
    ? Object.entries(options.functions).map(
        ([name, { description, parameters }]) => {
          return {
            name,
            description,
            parameters: zodToJsonSchema(parameters) as Record<string, unknown>,
          };
        },
      )
    : undefined;

  const tools = options.tools
    ? Object.entries(options.tools).map(
        ([name, { description, parameters }]) => {
          return {
            type: 'function' as const,
            function: {
              name,
              description,
              parameters: zodToJsonSchema(parameters) as Record<
                string,
                unknown
              >,
            },
          };
        },
      )
    : undefined;

  if (functions && tools) {
    throw new Error(
      "You can't have both functions and tools defined. Please choose one or the other.",
    );
  }

  let finished: Promise<void> | undefined;

  async function handleRender(
    args: any,
    renderer: undefined | Renderer<any, any>,
    res: ReturnType<typeof createStreamableUI>,
    final?: boolean,
  ) {
    if (!renderer) return;

    const resolvable = createResolvablePromise<void>();

    if (finished) {
      finished = finished.then(() => resolvable.promise);
    } else {
      finished = resolvable.promise;
    }

    const value = renderer(args);
    if (
      value instanceof Promise ||
      (value &&
        typeof value === 'object' &&
        'then' in value &&
        typeof value.then === 'function')
    ) {
      const node = await (value as Promise<React.ReactNode>);
      if (final) {
        if (typeof node === 'undefined') {
          res.done();
        } else {
          res.done(node);
        }
      } else {
        res.update(node);
      }
      resolvable.resolve(void 0);
    } else if (
      value &&
      typeof value === 'object' &&
      Symbol.asyncIterator in value
    ) {
      const it = value as AsyncGenerator<
        React.ReactNode,
        React.ReactNode,
        void
      >;
      while (true) {
        const { done, value } = await it.next();
        if (done) {
          if (final) {
            if (typeof value === 'undefined') {
              res.done();
            } else {
              res.done(value);
            }
          } else {
            res.update(value);
          }
          break;
        }
        res.update(value);
      }
      resolvable.resolve(void 0);
    } else if (value && typeof value === 'object' && Symbol.iterator in value) {
      const it = value as Generator<React.ReactNode, React.ReactNode, void>;
      while (true) {
        const { done, value } = it.next();
        if (done) {
          if (final) {
            if (typeof value === 'undefined') {
              res.done();
            } else {
              res.done(value);
            }
          } else {
            res.update(value);
          }
          break;
        }
        res.update(value);
      }
      resolvable.resolve(void 0);
    } else {
      if (final) {
        if (typeof value === 'undefined') {
          res.done();
        } else {
          res.done(value);
        }
      } else {
        res.update(value);
      }
      resolvable.resolve(void 0);
    }
  }

  (async () => {
    let finished = false;
    let hasFunction = false;
    let hasTextRender = !!textRender;
    let triggeredTextRender = false;
    let content = '';

    let textResolver: ReturnType<typeof createResolvablePromise<void>> | null =
      null;
    const textPayloads: TextPayload[] = [];
    const textSyncIterable = hasTextRender
      ? {
          [Symbol.asyncIterator]() {
            let done = false;
            return {
              async next() {
                if (done) {
                  return { done: true };
                }

                if (!textPayloads.length) {
                  await (textResolver = createResolvablePromise()).promise;
                  textResolver = null;
                }

                const payload = textPayloads.shift()!;
                if (payload.done) {
                  done = true;
                  return { done: false, value: payload };
                } else {
                  return { done: false, value: payload };
                }
              },
            };
          },
        }
      : null;

    consumeStream(
      OpenAIStream(
        (await options.provider.chat.completions.create({
          model: options.model,
          messages: options.messages,
          temperature: options.temperature,
          stream: true,
          ...(functions
            ? {
                functions,
              }
            : {}),
          ...(tools
            ? {
                tools,
              }
            : {}),
        })) as any,
        {
          ...(functions
            ? {
                async experimental_onFunctionCall(functionCallPayload) {
                  hasFunction = true;
                  handleRender(
                    functionCallPayload.arguments,
                    options.functions?.[functionCallPayload.name as any]
                      ?.render,
                    ui,
                    true,
                  );
                },
              }
            : {}),
          ...(tools
            ? {
                async experimental_onToolCall(toolCallPayload: any) {
                  hasFunction = true;

                  // TODO: We might need Promise.all here?
                  for (const tool of toolCallPayload.tools) {
                    handleRender(
                      tool.func.arguments,
                      options.tools?.[tool.func.name as any]?.render,
                      ui,
                    );
                  }

                  await finished;
                  ui.done();
                },
              }
            : {}),
          onText(chunk) {
            content += chunk;

            const payload = { content, done: false, delta: chunk };

            if (hasTextRender) {
              textPayloads.push(payload);
              if (textResolver) textResolver.resolve();
              if (!triggeredTextRender) {
                triggeredTextRender = true;
                handleRender(textSyncIterable, textRender, ui, true);
              }
            } else {
              handleRender(payload, text, ui);
            }
          },
          async onFinal() {
            if (finished) return;
            if (hasFunction) return;

            if (hasTextRender) {
              const payload = { content, done: true, delta: '' };
              textPayloads.push(payload);
              if (textResolver) textResolver.resolve();
              if (!triggeredTextRender) {
                triggeredTextRender = true;
                handleRender(textSyncIterable, textRender, ui, true);
              }
              return;
            }

            handleRender({ content, done: true }, text, ui);
            await finished;
            ui.done();
          },
        },
      ),
    );
  })();

  return ui.value;
}
