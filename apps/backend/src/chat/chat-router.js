import { getServiceHandler } from './service-handlers.js';

function normalize(input) {
  return String(input || '').trim().toLowerCase();
}

const GREETING_RE = /^(hi|hello|hey|hii|hola|start|yo)\b/i;
const MODULE_MENU = [
  { key: 'AUTO', label: 'Book Auto' },
  { key: 'TAXI', label: 'Book Taxi' },
  { key: 'SHOPPING', label: 'Order from Shops' },
  { key: 'SERVICE', label: 'Find Services' }
];

function menuText(services) {
  return `Please choose a service:\n${services.map((s, i) => `${i + 1}. ${s.name}`).join('\n')}`;
}

function moduleFromText(text) {
  if (/\bauto|rickshaw\b/.test(text)) return 'AUTO';
  if (/\btaxi|cab|ride\b/.test(text)) return 'TAXI';
  if (/\border|shop|grocery|mart|instamart|food|items\b/.test(text)) return 'SHOPPING';
  if (/\bservice|plumber|electrician|repair|cleaning\b/.test(text)) return 'SERVICE';
  return null;
}

function moduleReply(module, userText) {
  const compactText = String(userText || '').trim();
  const hasRoute = /\bfrom\b.+\bto\b/i.test(compactText) || compactText.split(',').length >= 2;
  switch (module) {
    case 'AUTO':
      return hasRoute
        ? {
            reply: 'Auto request captured. I am matching nearby auto drivers now.',
            action: 'auto_route_captured',
            quickReplies: ['Share live location', 'Show nearest autos', 'menu']
          }
        : {
            reply: 'Please share pickup and drop locations for your auto ride (example: "from MG Road to Railway Station").',
            action: 'auto_need_route',
            quickReplies: ['Share live location', 'menu']
          };
    case 'TAXI':
      return hasRoute
        ? {
            reply: 'Taxi booking request captured. I am matching nearby taxi drivers now.',
            action: 'taxi_route_captured',
            quickReplies: ['Share live location', 'Show nearest taxis', 'menu']
          }
        : {
            reply: 'Please share pickup and destination for your taxi ride.',
            action: 'taxi_need_route',
            quickReplies: ['Share live location', 'menu']
          };
    case 'SHOPPING':
      return compactText.length > 2
        ? {
            reply: `Great. I captured your shopping request: "${compactText}". I will connect nearby shops now.`,
            action: 'shopping_items_captured',
            quickReplies: ['Add more items', 'Show nearby shops', 'menu']
          }
        : {
            reply: 'Tell me the items you need (example: milk, bread, rice) and preferred delivery time.',
            action: 'shopping_need_items',
            quickReplies: ['Show nearby shops', 'menu']
          };
    case 'SERVICE':
      return compactText.length > 2
        ? {
            reply: `Understood. I can help with "${compactText}". Fetching nearby service providers.`,
            action: 'service_need_found',
            quickReplies: ['Show providers', 'menu']
          }
        : {
            reply: 'Tell me what service you need (plumber, electrician, appliance repair, etc.).',
            action: 'service_need_details',
            quickReplies: ['menu']
          };
    default:
      return {
        reply: 'I can help with rides, shopping, and local services.',
        action: 'module_unknown',
        quickReplies: MODULE_MENU.map((item) => item.label)
      };
  }
}

export async function routeChatMessage({ prisma, userId, message }) {
  const text = String(message || '').trim();
  const services = await prisma.service.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });

  let session = await prisma.chatSession.findFirst({ where: { userId }, orderBy: { updatedAt: 'desc' } });
  if (!session) {
    session = await prisma.chatSession.create({
      data: { userId, conversationStage: 'service_selection', lastAction: 'session_started' }
    });
  }

  if (!text) {
    return { reply: 'Please send a message to continue.', session };
  }

  await prisma.chatMessage.create({
    data: {
      userId,
      serviceId: session.currentServiceId || null,
      direction: 'inbound',
      content: text,
      metadata: { stage: session.conversationStage }
    }
  });

  const normalized = normalize(text);
  const selectedModule = moduleFromText(normalized);
  const isGreeting = GREETING_RE.test(normalized);
  const askedMenu = normalized === 'menu' || normalized === 'options' || normalized === 'start over' || normalized === 'reset';
  const sessionContext = session.context && typeof session.context === 'object' ? session.context : {};

  if (isGreeting || askedMenu) {
    const reply = 'Hi 👋 Choose what you need: Auto, Taxi, Shop orders, or Local services.';
    const quickReplies = MODULE_MENU.map((item) => item.label);
    session = await prisma.chatSession.update({
      where: { id: session.id },
      data: {
        currentServiceId: null,
        conversationStage: 'service_selection',
        lastAction: askedMenu ? 'menu_requested' : 'greeting_handled',
        context: { ...sessionContext, selectedModule: null }
      }
    });
    await prisma.chatMessage.create({
      data: { userId, direction: 'outbound', content: reply, metadata: { stage: session.conversationStage, quickReplies } }
    });
    return { reply, quickReplies, module: null, serviceMenu: services, session };
  }

  if (selectedModule || sessionContext.selectedModule) {
    const module = selectedModule || sessionContext.selectedModule;
    const response = moduleReply(module, text);
    session = await prisma.chatSession.update({
      where: { id: session.id },
      data: {
        conversationStage: 'module_flow',
        lastAction: response.action,
        context: { ...sessionContext, selectedModule: module }
      }
    });
    await prisma.chatMessage.create({
      data: {
        userId,
        direction: 'outbound',
        content: response.reply,
        metadata: { stage: session.conversationStage, module, quickReplies: response.quickReplies }
      }
    });
    return { reply: response.reply, quickReplies: response.quickReplies, module, session };
  }

  if (normalized === 'menu') {
    await prisma.chatSession.update({
      where: { id: session.id },
      data: { currentServiceId: null, conversationStage: 'service_selection', lastAction: 'menu_requested' }
    });
    const reply = services.length ? menuText(services) : 'No services are active right now.';
    return { reply, serviceMenu: services, session };
  }

  if (!services.length) {
    const reply = 'No services are active right now. Please try again later.';
    await prisma.chatMessage.create({ data: { userId, direction: 'outbound', content: reply } });
    return { reply, serviceMenu: [] };
  }

  if (!session.currentServiceId) {
    let selectedService = null;

    if (services.length === 1) {
      selectedService = services[0];
    } else {
      const choice = Number(normalized);
      if (Number.isInteger(choice) && choice > 0 && choice <= services.length) {
        selectedService = services[choice - 1];
      } else {
        selectedService = services.find((svc) => normalize(svc.name) === normalized);
      }

      if (!selectedService) {
        const reply = menuText(services);
        await prisma.chatMessage.create({ data: { userId, direction: 'outbound', content: reply } });
        return { reply, serviceMenu: services };
      }
    }

    session = await prisma.chatSession.update({
      where: { id: session.id },
      data: {
        currentServiceId: selectedService.id,
        conversationStage: 'service_selection',
        lastAction: 'service_selected'
      }
    });
  }

  const service = await prisma.service.findUnique({ where: { id: session.currentServiceId } });
  if (!service || !service.isActive) {
    const reply = 'Your current service is unavailable. Type "menu" to select another service.';
    await prisma.chatMessage.create({ data: { userId, direction: 'outbound', content: reply } });
    return { reply };
  }

  const handler = getServiceHandler(service.handlerKey);
  if (!handler) {
    const reply = 'Service handler is not configured. Please contact support.';
    await prisma.chatMessage.create({ data: { userId, serviceId: service.id, direction: 'outbound', content: reply } });
    return { reply, service: { id: service.id, name: service.name } };
  }

  const response = await handler({ message: text, session, service });

  session = await prisma.chatSession.update({
    where: { id: session.id },
    data: {
      conversationStage: response.nextStage || session.conversationStage,
      lastAction: response.action || 'handled',
      currentServiceId: service.id
    }
  });

  await prisma.chatMessage.create({
    data: {
      userId,
      serviceId: service.id,
      direction: 'outbound',
      content: response.reply,
      metadata: { stage: session.conversationStage }
    }
  });

  return {
    reply: response.reply,
    service: { id: service.id, name: service.name },
    session
  };
}
