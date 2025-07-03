/* eslint-env jest */

const { buildMessages } = require('../../src/utils/promptBuilder');

describe('Prompt Builder', () => {
  const systemMessage = 'You are a test assistant.';
  const history = [
    { role: 'user', content: 'First message' },
    { role: 'assistant', content: 'First response' },
  ];
  const taskMessage = 'Perform this specific task.';

  it('should build a complete message array with all parts', () => {
    const messages = buildMessages(systemMessage, history, taskMessage);

    expect(messages).toEqual([
      { role: 'system', content: systemMessage },
      ...history,
      { role: 'user', content: taskMessage },
    ]);
  });

  it('should build correctly without a task message', () => {
    const messages = buildMessages(systemMessage, history, null);

    expect(messages).toEqual([
      { role: 'system', content: systemMessage },
      ...history,
    ]);
  });

  it('should build correctly with an empty history', () => {
    const messages = buildMessages(systemMessage, [], taskMessage);

    expect(messages).toEqual([
      { role: 'system', content: systemMessage },
      { role: 'user', content: taskMessage },
    ]);
  });

  it('should build correctly with null history', () => {
    const messages = buildMessages(systemMessage, null, taskMessage);

    expect(messages).toEqual([
      { role: 'system', content: systemMessage },
      { role: 'user', content: taskMessage },
    ]);
  });
  
  it('should build correctly with only a system message', () => {
    const messages = buildMessages(systemMessage, null, null);

    expect(messages).toEqual([
      { role: 'system', content: systemMessage },
    ]);
  });

  it('should throw an error if systemMessage is null or empty', () => {
    expect(() => buildMessages(null, history, taskMessage)).toThrow(
      'A systemMessage is required to build the prompt.'
    );
    expect(() => buildMessages('', history, taskMessage)).toThrow(
        'A systemMessage is required to build the prompt.'
    );
  });
}); 