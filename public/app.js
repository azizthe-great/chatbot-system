const form = document.querySelector('#chat-form');
const input = document.querySelector('#message');
const messages = document.querySelector('#messages');
const submitButton = form.querySelector('button');

function addMessage(text, sender) {
  const message = document.createElement('div');
  message.className = `message ${sender}-message`;
  message.innerHTML = `<span class="message-label">${sender === 'user' ? 'You' : 'Bot'}</span><p></p>`;
  message.querySelector('p').textContent = text;
  messages.appendChild(message);
  messages.scrollTop = messages.scrollHeight;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = input.value.trim();

  if (!message) return;

  addMessage(message, 'user');
  input.value = '';
  submitButton.disabled = true;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    const data = await response.json();

    if (!response.ok) throw new Error(data.error || 'Unable to get response');
    addMessage(data.reply, 'bot');
  } catch (error) {
    addMessage(error.message, 'bot');
  } finally {
    submitButton.disabled = false;
    input.focus();
  }
});
