// Ask Fiddy's agent from a mini app: the app's own side of the ask channel.
//
// Load this file in your app and call `fiddy.agentAsk(ask, text, embeds)`. The
// shell answers every ask it accepts with one state word and one sentence you
// may show, and it never sends back anything the person using Fiddy typed
// somewhere else — no agent words, no cast, no profile.
//
//   ask     'draft' | 'post' | 'remind'
//   text    plain text, up to 500 characters
//   embeds  optional, up to two https links, `draft` only
//
// Three asks are allowed per app per window, and the person using Fiddy can
// mute your app in that window; the answer says which of those happened. A
// state word is always an answer, so never invent one of your own.
//
// The shell drops anything that did not come from your app's own window, so an
// ask can also be left unanswered. Race it with your own timeout if you need
// one; do not read a refusal into the silence.
(function () {
  var ASK_MESSAGE = 'fiddy:agent-ask';
  var RESULT_MESSAGE = 'fiddy:agent-ask-result';
  var VERSION = 1;
  var waiting = {};

  window.addEventListener('message', function (event) {
    // Only the shell answers, and the shell is this window's parent. The origin
    // is not checked against a hard-coded value: the shell is what it is, and a
    // pinned origin would break the moment you run your app anywhere else.
    if (event.source !== window.parent) {
      return;
    }
    var data = event.data;
    if (!data || data.type !== RESULT_MESSAGE || data.v !== VERSION) {
      return;
    }
    var resolve = waiting[data.id];
    if (!resolve) {
      return;
    }
    delete waiting[data.id];
    resolve({ state: data.state, message: data.message });
  });

  window.fiddy = window.fiddy || {};
  window.fiddy.agentAsk = function (ask, text, embeds) {
    var id = 'ask-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    var request = {
      type: ASK_MESSAGE,
      v: VERSION,
      id: id,
      ask: ask,
      text: text,
    };
    if (embeds) {
      request.embeds = embeds;
    }
    return new Promise(function (resolve) {
      waiting[id] = resolve;
      // The target origin here is your own business: Fiddy validates the ask
      // against who really sent it, not against what you claim.
      window.parent.postMessage(request, '*');
    });
  };
})();
