import { getServiceHandler } from './service-handlers.js';

function normalize(input) {
  return String(input || '').trim().toLowerCase();
}

function menuText(services) {
  return `Please choose a service:\n${services.map((s, i) => `${i + 1}. ${s.name}`).join('\n')}`;
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
