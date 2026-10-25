import { directions, sources } from './validation.mjs';

// Derive context from the validated v1 payload. A general form's selected
// directions are interests, not evidence that it was opened in a product block.
export function inquiryContext(lead) {
  const directionIds = lead.product ? [lead.product] : lead.interests.filter(id => id !== 'undecided');
  const topic = directionIds.length ? directionIds.map(id => directions[id]).join(', ') : 'Нужен совет';
  const sourceBlock = lead.source === 'brand-modal' ? lead.product : lead.source === 'inline' ? 'contact' : 'hero';
  const sourceBlockLabel = lead.source === 'brand-modal' ? `Блок ${directions[lead.product]}`
    : lead.source === 'inline' ? 'Нижний блок «Обсудить ваш проект»' : 'Первый экран — «Обсудить ваш проект»';
  const model = lead.model?.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const title = `Сайт DAO — ${topic}${model ? ` — ${model}` : ''}`;
  return { directionIds, topic, sourceBlock, sourceBlockLabel, formLabel: sources[lead.source],
    title: [...title].slice(0, 250).join('') };
}
