export const serviceHandlers = {
  autoHandler: async ({ message, session, service }) => {
    const text = String(message || '').toLowerCase();
    if (session.conversationStage === 'service_selection') {
      return {
        reply: 'Great, I can help with rides. Share pickup and drop locations to continue.',
        nextStage: 'awaiting_route',
        action: 'auto_start'
      };
    }

    if (session.conversationStage === 'awaiting_route') {
      return {
        reply: `Ride request captured for ${service.name}. A nearby driver will be matched shortly.`,
        nextStage: 'request_submitted',
        action: text.includes('cancel') ? 'cancel_requested' : 'route_captured'
      };
    }

    return {
      reply: 'Auto service is active. Type "menu" anytime to switch services.',
      nextStage: session.conversationStage,
      action: 'auto_followup'
    };
  },

  shopHandler: async ({ message, session, service }) => {
    const text = String(message || '').trim();
    if (session.conversationStage === 'service_selection') {
      return {
        reply: 'Sure — tell me what items you need and your preferred delivery time.',
        nextStage: 'awaiting_cart',
        action: 'shop_start'
      };
    }

    if (session.conversationStage === 'awaiting_cart') {
      return {
        reply: `Got it. I captured "${text}" for ${service.name}. A local vendor will respond soon.`,
        nextStage: 'request_submitted',
        action: 'cart_captured'
      };
    }

    return {
      reply: 'Shopping service is active. Type "menu" to switch services.',
      nextStage: session.conversationStage,
      action: 'shop_followup'
    };
  }
};

export function getServiceHandler(handlerKey) {
  return serviceHandlers[handlerKey] || null;
}
