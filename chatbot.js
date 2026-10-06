const greetingPatterns = [
  /\b(hi|hello|hey)\b/i,
  /\b(good morning|good afternoon|good evening)\b/i
];

const helpPatterns = [
  /\b(help|assist|support|what can you do)\b/i,
  /\b(what can you help me with)\b/i
];

function getReply(message) {
  const text = message.trim();

  if (greetingPatterns.some((pattern) => pattern.test(text))) {
    return 'Hello! I am your chatbot. How can I help you today?';
  }

  if (helpPatterns.some((pattern) => pattern.test(text))) {
    return 'I can help with greetings, basic questions, and project support. What would you like to try?';
  }

  if (/\b(exit|quit|stop)\b/i.test(text)) {
    return 'Thanks for using the chatbot. See you next time!';
  }

  return 'I can help with basic questions or greetings. Please tell me what you need help with.';
}

module.exports = { getReply };
