/**
 * The starter library of canned responses, in Arabic and English.
 *
 * Content rather than code, kept here rather than in a migration for the reason
 * `lib/kb/handbook.ts` gives: the rows are derived through `cannedBodyColumns`,
 * which a hand-written SQL twin would have to repeat.
 * `worker/handlers/seed-canned-responses.ts` is what puts them in the database,
 * and after that they belong to the team — reworded, renamed and regrouped in
 * the console like any response somebody typed there.
 *
 * Organised by what the customer wrote about, following the areas in
 * `lib/categorise/taxonomy.ts`, so the response an agent reaches for sits under
 * the same heading as the category the ticket was filed under. Two audiences
 * write in and they need different answers to the same question: a recipient
 * waiting for a parcel, who never chose ShipBlu, and a merchant, who pays for
 * it. Where a folder holds both, the title says which.
 *
 * Six decisions are worth knowing before editing a response, and
 * `canned-library.test.ts` holds each one that can be checked.
 *
 * **Every body is sendable exactly as it stands.** Nothing interpolates: the
 * composer inserts the text verbatim, and an automation rule sends it without
 * anybody reading it. So there is no placeholder anywhere — no `[date]`, no
 * customer name — and a response is written so that no blank is needed: it
 * refers to "the date you asked for" rather than restating it. A response that
 * cannot be written that way is the wrong response to have in a library.
 *
 * **No links, addresses or phone numbers.** `support.shipblu.com` still serves
 * the Freshdesk help centre while this one is reached elsewhere, so a URL here
 * would point at the old site and go stale silently. Responses say "the
 * tracking page in our help centre"; the agent adds the link from the
 * knowledge panel, which builds it from the live host. The customer is already
 * talking to support, so nothing tells them to contact it.
 *
 * **1000 characters at most**, which is Instagram's limit for a direct message
 * and the strictest of the five channels the same text goes out on. Most are
 * far shorter: they are read on a phone, mid-conversation.
 *
 * **The Arabic addresses the customer as «حضرتك» and gives no gender away.**
 * We never know the customer's gender, and the text does not know the
 * agent's. «حضرتك» is the standard courteous form in Egypt and it is neutral;
 * imperatives are not (أرسل / أرسلي), so an instruction reads «يُرجى…» or
 * «يمكن لحضرتك…», and an agent's feelings are verbs («يسعدني»), never an
 * adjective that has to agree with somebody. The two bodies are the same
 * response written twice, not one translated from the other.
 *
 * **Policy comes from the help centre, never from memory.** Every timeframe,
 * limit and procedure stated below is one ShipBlu's own help centre stated on
 * 2026-10-05: delivery hours and attempts, the 24-hour damage-claim window and
 * what a claim needs, the myBlu refund path, the COD ceiling, Fees on Delivery,
 * the dashboard menus. When one of those articles changes, the response quoting
 * it changes in the same pull request — and it is shipped by re-running the
 * seed with `overwrite=true` after a dry run, because a canned response has no
 * version history to undo it with.
 *
 * **The titles and folders are English**, because the console they are read in
 * is. The picker sorts folders and titles alphabetically, so a title starts
 * with the situation an agent is looking at rather than with a verb.
 */

export type LibraryResponse = {
  /** Stable identity. Becomes `canned_responses.seed_key` as `library:<key>`. */
  key: string;
  /** The agent's label in the picker. */
  title: string;
  ar: string;
  en: string;
};

export type LibraryFolder = {
  /** Stored as `canned_responses.folder`, the picker's group heading. */
  name: string;
  responses: LibraryResponse[];
};

/** What the seed writes into `seed_key`, so its rows are told apart from typed ones. */
export function librarySeedKey(key: string): string {
  return `library:${key}`;
}

/** Paragraphs as they are written, joined the way `textToHtml` splits them. */
function body(...paragraphs: string[]): string {
  return paragraphs.join('\n\n');
}

function reply(key: string, title: string, text: { ar: string[]; en: string[] }): LibraryResponse {
  return { key, title, ar: body(...text.ar), en: body(...text.en) };
}

export const CANNED_LIBRARY: LibraryFolder[] = [
  // ── General ───────────────────────────────────────────────────────────────────
  // Openers, holding replies and closers that fit any conversation.
  {
    name: 'General',
    responses: [
      reply('general.greeting', 'Greeting — how can I help', {
        ar: [
          'أهلًا بحضرتك في خدمة عملاء شيب بلو. كيف يمكنني مساعدة حضرتك اليوم؟',
          'وإذا كان الاستفسار بخصوص شحنة، فإرسال رقم تتبعها سيساعدني على متابعتها بشكل أسرع.',
        ],
        en: [
          'Hi, and welcome to ShipBlu support. How can I help you today?',
          'If your question is about a shipment, sending its tracking number will help me look into it faster.',
        ],
      }),
      reply('general.ask_tracking_number', 'Tracking number — ask for it (private chats only)', {
        ar: [
          'هل يمكن لحضرتك إرسال رقم تتبع الشحنة؟ فهو يساعدني على الوصول إليها في نظامنا ومعرفة آخر حالة لها.',
          'ويمكن لحضرتك العثور على رقم التتبع عادةً في الرسالة النصية (SMS) التي وصلت من شيب بلو، أو في رسالة تأكيد الطلب من المتجر.',
        ],
        en: [
          "Could you send me your shipment's tracking number? It lets me find it in our system and check its latest status.",
          "It's usually in the text message from ShipBlu, or in the store's order confirmation.",
        ],
      }),
      reply('general.ask_details', 'Unclear message — ask for details', {
        ar: [
          'هل يمكن لحضرتك توضيح ما حدث بمزيد من التفاصيل؟ أودّ أن أفهم الأمر بدقة قبل مراجعته.',
          'وإذا كانت لدى حضرتك صورة أو لقطة شاشة للمشكلة، فيُرجى إرسالها أيضًا. وإن كان الأمر يخص شحنة، فرقم التتبع سيساعدني على الوصول إليها فورًا.',
        ],
        en: [
          'Could you tell me a bit more about what happened? I want to be sure I understand it properly before I look into it.',
          'If you have a screenshot or a photo, please send it too. And if this is about a shipment, the tracking number will let me find it straight away.',
        ],
      }),
      reply('general.checking', "Checking now — I'll update you shortly", {
        ar: [
          'شكرًا لحضرتك على الانتظار. أراجع الأمر الآن، وسأوافي حضرتك بالمستجدات هنا خلال وقت قصير.',
        ],
        en: ["Thanks for waiting. I'm looking into this now and will update you here shortly."],
      }),
      reply('general.follow_up', 'Follow-up — waiting on the customer', {
        ar: [
          'نتابع مع حضرتك بخصوص رسالتنا السابقة، إذ لم يصلنا رد حتى الآن، وما زلنا بحاجة إلى المعلومات المطلوبة لاستكمال مراجعة الأمر.',
          'ويمكن لحضرتك الرد هنا في أي وقت مناسب، وسيسعدني أن نواصل من حيث توقفنا.',
        ],
        en: [
          "Just following up on our last message, since we haven't heard back yet. We still need the information we asked for to move this forward.",
          "Whenever you're ready, reply here and I'll be happy to pick up where we left off.",
        ],
      }),
      reply('general.anything_else', 'Closing — anything else I can help with?', {
        ar: ['هل هناك أي شيء آخر يمكنني مساعدة حضرتك فيه؟'],
        en: ['Is there anything else I can help you with today?'],
      }),
      reply('general.resolved', "Closing — glad it's sorted", {
        ar: [
          'يسعدني أننا وصلنا إلى حل، وأشكر حضرتك على التعاون.',
          'وإذا كان هناك أي استفسار آخر، فيمكن لحضرتك الرد على هذه المحادثة، ويسرّنا تقديم المساعدة دائمًا.',
        ],
        en: [
          "I'm glad we got this sorted, and thanks for working through it with me.",
          "If anything else comes up, just reply to this conversation and we'll be happy to help.",
        ],
      }),
      reply('general.praise', 'Praise — thanks for the kind words', {
        ar: [
          'شكرًا جزيلًا لحضرتك على هذه الكلمات الطيبة التي أسعدتنا كثيرًا، وسأحرص على نقلها إلى الفريق.',
        ],
        en: [
          "Thank you so much for your kind words. They mean a lot to us, and I'll be sure to share your message with the team.",
        ],
      }),
      reply('general.human', "Asked for a human — you're talking to a person", {
        ar: [
          'يرد على حضرتك الآن شخص حقيقي من فريق خدمة عملاء شيب بلو، وليس نظامًا آليًا.',
          'كيف يمكنني مساعدة حضرتك؟',
        ],
        en: [
          "You're talking to a real person on the ShipBlu support team, not an automated system.",
          'How can I help?',
        ],
      }),
      reply('general.slow_reply', 'Slow reply — sorry for the wait', {
        ar: [
          'نعتذر لحضرتك عن التأخر في الرد، وشكرًا على المتابعة. أتابع الأمر بنفسي الآن، وسأُطلع حضرتك على كل جديد هنا أولًا بأول.',
        ],
        en: [
          "I'm sorry it's taken us a while to get back to you, and thanks for following up. I'm on it now, and I'll keep you posted right here.",
        ],
      }),
      reply('general.complaint', "Complaint received — I've escalated it", {
        ar: [
          'شكرًا لحضرتك على إبلاغنا، ونعتذر عن تجربة لم تكن بالمستوى الذي يليق بحضرتك. نتفهم تمامًا مدى الإزعاج الذي سببه هذا الموقف.',
          'رفعتُ شكوى حضرتك إلى الفريق المسؤول لمراجعة ما حدث، وسأوافي حضرتك بالمستجدات هنا فور وصول ردهم.',
        ],
        en: [
          "Thank you for telling us about this, and I'm sorry it wasn't the experience you should have had. I can see how frustrating it's been.",
          "I've raised your complaint with the team responsible so they can look into what happened. I'll update you here as soon as I hear back.",
        ],
      }),
      reply('general.handover', 'Handover — passed to the specialist team', {
        ar: [
          'حوّلتُ طلب حضرتك إلى الفريق المختص بمتابعته، وسنوافي حضرتك بالمستجدات في المحادثة نفسها، لذا لا داعي لإعادة إرساله.',
        ],
        en: [
          "I've passed your request to the team that handles this. We'll update you in this same conversation, so there's no need to send it again.",
        ],
      }),
    ],
  },
  // ── Delivery ──────────────────────────────────────────────────────────────────
  // Recipients asking where a parcel is, or changing how it reaches them.
  {
    name: 'Delivery',
    responses: [
      reply('delivery.track', 'Where is my parcel — how to track', {
        ar: [
          'يمكن لحضرتك متابعة الشحنة في أي وقت بإدخال رقم التتبع في صفحة التتبع بمركز المساعدة لدينا.',
          'وللمتابعة لحظة بلحظة، يتوفر تطبيق ماي بلو (myBlu) على أندرويد وآيفون، ويمكن العثور عليه في متجر التطبيقات بالبحث عن «ShipBlu» أو «myBlu». ثم يتم تسجيل الدخول برقم الهاتف الذي أُرسلت إليه الرسالة النصية الخاصة بالشحنة، مع رمز التحقق الذي يصل إليه.',
          'وإذا كان ذلك أسهل لحضرتك، فيمكن إرسال رقم التتبع هنا وسأراجع حالة الشحنة بنفسي.',
        ],
        en: [
          'You can follow your shipment at any time by entering its tracking number on the tracking page in our help centre.',
          'For live updates, use the myBlu app on Android or iPhone. Search for "ShipBlu" or "myBlu" in your app store, then log in with the mobile number that got the shipment\'s text message, using the verification code sent to it.',
          "If it's easier, send me the tracking number here and I'll check on your shipment myself.",
        ],
      }),
      reply('delivery.hours', 'Delivery days, hours and attempts', {
        ar: [
          'يوصّل مندوبونا الشحنات يوميًا طوال أيام الأسبوع، من السبت إلى الجمعة، بين الساعة 10 صباحًا و7 مساءً، وقد تمتد مواعيد التوصيل إلى ما بعد ذلك في مواسم الذروة.',
          'وتُجرى حتى ثلاث محاولات لتوصيل كل شحنة، وتصل رسالة نصية عند خروج الشحنة للتوصيل، ثم يتصل المندوب قبل الوصول.',
        ],
        en: [
          'Our couriers deliver every day of the week, Saturday to Friday, between 10 AM and 7 PM. During peak seasons, deliveries can run later than usual.',
          'Each shipment gets up to three delivery attempts. A text message goes out when the shipment is out for delivery, and the courier calls before arriving.',
        ],
      }),
      reply('delivery.out_for_delivery', 'Out for delivery today', {
        ar: [
          'يسعدني إبلاغ حضرتك بأن الشحنة خرجت للتوصيل اليوم، وهي الآن مع المندوب.',
          'مواعيد التوصيل من الساعة 10 صباحًا حتى 7 مساءً، وقد تمتد إلى ما بعد ذلك في مواسم الذروة. وسيتصل المندوب بحضرتك للتنسيق قبل الوصول، لذا نرجو أن يكون الهاتف قريبًا ومتاحًا للرد.',
          'ويمكن لحضرتك أيضًا متابعة موقع المندوب لحظة بلحظة من خلال تطبيق ماي بلو (myBlu).',
        ],
        en: [
          'Good news: your shipment is with the courier and out for delivery today.',
          'Deliveries run from 10 AM to 7 PM, and can run later than usual during peak seasons. The courier will call you before arriving, so please keep your phone close and reachable.',
          "You can also follow the courier's live location in the myBlu app.",
        ],
      }),
      reply('delivery.in_transit', 'On its way — not out for delivery yet', {
        ar: [
          'الشحنة في طريقها الآن عبر شبكتنا إلى مركز التوزيع الذي يخدم منطقة حضرتك، ولم تخرج للتوصيل بعد.',
          'وبمجرد خروجها للتوصيل ستصل إلى حضرتك رسالة نصية، ثم يتصل المندوب للتنسيق قبل الوصول. وحتى ذلك الحين، يمكن لحضرتك متابعة تحديثات الشحنة لحظة بلحظة من خلال تطبيق ماي بلو (myBlu).',
        ],
        en: [
          "Your shipment is on its way through our network to the hub that serves your area. It hasn't gone out for delivery yet.",
          "Once it does, you'll get a text message, and the courier will call you before arriving. In the meantime, you can follow every update in real time in the myBlu app.",
        ],
      }),
      reply('delivery.late', 'Delivery is late — escalated', {
        ar: [
          'نعتذر لحضرتك عن تأخر توصيل الشحنة، ونتفهم تمامًا انزعاج حضرتك من طول الانتظار.',
          'رفعت الأمر إلى فريق العمليات وطلبت إعطاء الأولوية للشحنة، وسأتابعها بنفسي وأبلغ حضرتك بأي جديد في هذه المحادثة.',
        ],
        en: [
          "I'm sorry your shipment is taking longer than expected, and I understand how frustrating the wait is.",
          "I've raised it with our operations team and asked them to prioritise it. I'll keep an eye on it and update you here.",
        ],
      }),
      reply('delivery.attempt_disputed', 'Attempt recorded, no one came — reattempt booked', {
        ar: [
          'نعتذر لحضرتك عمّا حدث، وشكرًا على إبلاغنا بأن أحدًا لم يحضر رغم تسجيل محاولة توصيل على الشحنة.',
          'أبلغت فريق العمليات بالأمر للتحقق منه، ورتبت محاولة توصيل جديدة. وسيتصل المندوب بحضرتك قبل الوصول، لذا نرجو أن يكون الهاتف متاحًا للرد.',
        ],
        en: [
          "I'm sorry about this, and thanks for telling us that no one came even though a delivery attempt was recorded.",
          "I've reported this to our operations team so they can look into what happened, and I've arranged another delivery attempt. The courier will call you before arriving, so please keep your phone reachable.",
        ],
      }),
      reply('delivery.no_call', "Courier didn't call before the attempt", {
        ar: [
          'نعتذر عن عدم اتصال المندوب بحضرتك للتنسيق قبل محاولة التوصيل.',
          'نقلت هذه الملاحظة إلى فريق العمليات، وطلبت أن يتصل المندوب بحضرتك قبل المحاولة التالية.',
          'وإذا كان رقم الهاتف المسجل على الشحنة قد تغيّر، يُرجى إرسال الرقم الصحيح هنا وسأنقله إلى الفريق أيضًا.',
        ],
        en: [
          "I'm sorry the courier didn't call you before the delivery attempt.",
          "I've passed this to our operations team and asked for the courier to call you before the next attempt.",
          "If the phone number on your shipment might be out of date, send me the right one and I'll pass it on too.",
        ],
      }),
      reply('delivery.reschedule_done', 'Change delivery date — confirmed', {
        ar: [
          'نقلت الموعد الذي حددته حضرتك لاستلام الشحنة إلى فريق العمليات، وسيتصل المندوب بحضرتك في ذلك اليوم قبل الوصول.',
          'وإذا تغيّرت ظروف حضرتك، فيمكن اختيار موعد توصيل آخر مباشرةً من خلال تطبيق ماي بلو (myBlu).',
        ],
        en: [
          "All set. I've passed the date you asked for to our operations team, and the courier will call you on that day before arriving.",
          'If your plans change, you can choose a different delivery date yourself in the myBlu app.',
        ],
      }),
      reply('delivery.reschedule_ask', 'Change delivery date — ask for the day', {
        ar: [
          'يمكن لحضرتك اختيار موعد التوصيل المناسب من خلال تطبيق ماي بلو (myBlu) المتاح على أندرويد وآيفون، بتسجيل الدخول برقم الهاتف الذي وصلته الرسالة النصية الخاصة بالشحنة، مع رمز التحقق الذي يصل إليه.',
          'وإذا كان ذلك أسهل، يمكن إبلاغي هنا باليوم الأنسب لحضرتك، وسأنقله إلى فريق العمليات. وتُجرى حتى ثلاث محاولات لتوصيل كل شحنة، ويتصل المندوب بحضرتك قبل الوصول.',
        ],
        en: [
          "You can pick a delivery date that suits you in the myBlu app, on Android or iPhone. Log in with the mobile number that got the shipment's text message, using the verification code sent to it.",
          "If it's easier, tell me which day works better and I'll pass it on to our operations team. Each shipment gets up to three delivery attempts, and the courier will call you before arriving.",
        ],
      }),
      reply('delivery.address_ask', 'Change address — ask for the new address', {
        ar: [
          'يسعدني تعديل عنوان التوصيل. يُرجى إرسال العنوان الجديد كاملًا، على أن يشمل:',
          '1. المحافظة والمنطقة واسم الشارع\n2. رقم المبنى والدور ورقم الشقة\n3. علامة مميزة قريبة\n4. رقم هاتف يمكن للمندوب الاتصال بحضرتك من خلاله',
          'ويمكن لحضرتك أيضًا تعديل العنوان مباشرةً من خلال تطبيق ماي بلو (myBlu) إذا كان ذلك أسهل.',
        ],
        en: [
          'I can update the delivery address for you. Please send the full new address, with:',
          '1. City, area and street name\n2. Building number, floor and apartment\n3. A nearby landmark\n4. A phone number the courier can reach you on',
          "You can also change the address yourself in the myBlu app if that's easier.",
        ],
      }),
      reply('delivery.address_done', 'Change address — updated', {
        ar: [
          'نقلت العنوان الجديد إلى فريق العمليات، وستصل الشحنة إليه بدلًا من العنوان السابق. وكالمعتاد، سيتصل المندوب بحضرتك قبل الوصول.',
          'وإذا كان العنوان الجديد في منطقة مختلفة، فقد يستغرق التوصيل وقتًا أطول قليلًا.',
        ],
        en: [
          "I've passed your new address to our operations team, so your shipment will now be delivered there. As usual, the courier will call you before arriving.",
          'If the new address is in a different area from the original one, delivery may take a little longer.',
        ],
      }),
      reply('delivery.access_note', 'Access instructions passed to the courier', {
        ar: [
          'شكرًا لحضرتك على هذه التفاصيل، فهي مفيدة جدًا. أضفت الملاحظة إلى بيانات الشحنة ليتمكن المندوب من الاطلاع عليها قبل التوجه إلى حضرتك.',
          'كما سيتصل المندوب قبل الوصول لتأكيد أي تفاصيل في يوم التوصيل. ولإضافة ملاحظات أخرى لاحقًا، يمكن لحضرتك استخدام تطبيق ماي بلو (myBlu) مباشرةً.',
        ],
        en: [
          "Thanks, that's really helpful. I've added your note to your shipment so the courier can see it before heading to you.",
          "The courier will also call before arriving, in case anything needs confirming on the day. If you'd like to add more notes later, you can do that yourself in the myBlu app.",
        ],
      }),
      reply('delivery.marked_delivered', 'Marked delivered but not received', {
        ar: [
          'من المقلق فعلًا أن تظهر الشحنة مُسلَّمة وهي لم تصل إلى حضرتك، ونأسف لذلك، ونتعامل مع الأمر بكل جدية.',
          'نرجو من حضرتك أولًا سؤال أفراد الأسرة أو الجيران أو حارس العقار، فربما استلمها أحدهم نيابةً عن حضرتك. وإذا كانت الشحنة لدى أحدهم، يُرجى إبلاغي هنا.',
          'وفي الوقت نفسه، طلبت من فريق العمليات فتح تحقيق في الأمر، وسأُطلع حضرتك هنا على ما يتوصل إليه الفريق.',
        ],
        en: [
          "Seeing your shipment marked as delivered when it hasn't reached you is worrying, and I'm sorry you're dealing with it. We're taking this seriously.",
          "First, could you check with family members, neighbours or your building's security, in case someone received it on your behalf? If one of them has it, just let me know here.",
          "In the meantime, I've opened an investigation with our operations team, and I'll let you know here what they find.",
        ],
      }),
      reply('delivery.refuse', 'Refusing the parcel', {
        ar: [
          'لا مشكلة. يمكن لحضرتك رفض استلام الشحنة عند اتصال المندوب أو عند وصوله، وستعود الشحنة إلى المتجر الذي أرسلها.',
          'وتختار بعض المتاجر تحصيل رسوم توصيل في حال رفض الشحنة، لتغطية تكلفة التوصيل. فإذا كان المتجر قد حدد هذه الرسوم لهذا الطلب، فسيطلبها المندوب عند الرفض.',
          'وإذا كان الدفع للمتجر مقدمًا، فيتم ترتيب استرداد المبلغ مع المتجر مباشرةً. أما إذا كان الدفع من خلال تطبيق ماي بلو (myBlu)، فيُرجى إبلاغي وسأوضح لحضرتك طريقة تقديم طلب الاسترداد.',
        ],
        en: [
          'No problem. You can decline the shipment when the courier calls or arrives, and it will go back to the store that sent it.',
          'Some stores choose to have a delivery fee collected when a shipment is refused, to cover the delivery cost. If the store has set one for this order, the courier will ask for it.',
          "If you paid the store in advance, any refund is arranged with the store. If you paid through the myBlu app, let me know and I'll explain how to request a refund.",
        ],
      }),
      reply('delivery.unrecognised', "Doesn't recognise the parcel", {
        ar: [
          'شيب بلو شركة شحن تتولى توصيل الطلبات نيابةً عن المتاجر الإلكترونية، وهذه الشحنة مُرسلة من متجر يظهر على طلبه اسم حضرتك ورقم الهاتف الخاص بحضرتك.',
          'ولمعرفة اسم المتجر، يمكن سؤال المندوب عند اتصاله.',
          'وإذا لم يكن هذا الطلب من حضرتك، يمكن رفض استلام الشحنة عند الباب، وستعود إلى المتجر.',
        ],
        en: [
          'ShipBlu delivers orders on behalf of online stores. This shipment was sent by a store that has your name and phone number on the order.',
          "To find out which store it's from, you can ask the courier when they call.",
          "If you didn't order anything, you can refuse the shipment at the door, and it will go back to the store.",
        ],
      }),
    ],
  },
  // ── Payment at the door ───────────────────────────────────────────────────────
  // Money collected on delivery, which the store sets and ShipBlu only collects.
  {
    name: 'Payment at the door',
    responses: [
      reply('payment.cod_amount', 'Cash amount is set by the store', {
        ar: [
          'المبلغ المطلوب عند الاستلام يحدده المتجر الذي طلبت منه حضرتك، وتحصّله شيب بلو نيابةً عنه، لذلك لا نملك صلاحية تعديله.',
          'وإذا بدا المبلغ غير صحيح، نرجو من حضرتك التواصل مع المتجر للتأكد منه قبل استلام الشحنة.',
          'وبعد تسليم الشحنة يُحوَّل المبلغ المحصَّل إلى المتجر تلقائيًا، لذا لا يمكننا إعادته، ويتم ترتيب أي استرداد مع المتجر مباشرةً.',
        ],
        en: [
          "The amount due on delivery is set by the store you ordered from. ShipBlu collects it on the store's behalf, so we're not able to change it.",
          "If the amount doesn't look right, please check with the store before accepting the shipment.",
          "Once a shipment is delivered, the amount collected is transferred to the store automatically, so we can't refund it. Any refund is arranged with the store directly.",
        ],
      }),
      reply('payment.fod', 'Delivery fee on refusal (FOD)', {
        ar: [
          'الرسوم التي يطلبها المندوب عند رفض الشحنة هي رسوم توصيل يحددها المتجر لتغطية تكلفة التوصيل. ولا تفرضها كل المتاجر، فالمتجر هو الذي يقرر تحصيلها من عدمه ويحدد قيمتها.',
          'ويحصّلها مندوبنا نيابةً عن المتجر، لذا يُرجى التواصل مع المتجر مباشرةً لأي استفسار بخصوص هذه الرسوم.',
        ],
        en: [
          'The fee the courier asks for when a shipment is refused is a delivery fee set by the store, to cover the cost of delivering it. Not every store charges one; the store decides whether to, and how much.',
          "Our courier collects it on the store's behalf, so if you have any questions about the fee, the store is the right place to ask.",
        ],
      }),
    ],
  },
  // ── Parcel condition ──────────────────────────────────────────────────────────
  // Damaged, wrong or missing items, for the recipient and for the merchant claim.
  {
    name: 'Parcel condition',
    responses: [
      reply('condition.damaged_recipient', 'Damaged parcel (recipient)', {
        ar: [
          'يؤسفنا أن شحنة حضرتك وصلت متضررة. نرجو من حضرتك الاحتفاظ بالشحنة وبكل مواد التغليف كما هي، لأنه لا يمكن قبول شكوى التلف بعد التخلص من التغليف.',
          'ولتسجيل الشكوى، يُرجى إرسال ما يلي في أقرب وقت:',
          '1. صور للمنتج يظهر فيها التلف\n2. صور للتغليف\n3. رقم تتبع الشحنة',
          'وبمجرد وصول الصور ورقم التتبع، سأرفع الشكوى إلى الفريق المختص. أما الاستبدال أو استرداد المبلغ فيكون بالاتفاق مع المتجر مباشرةً، لذا من الأفضل التواصل معه أيضًا.',
        ],
        en: [
          "I'm sorry your shipment arrived damaged. Please keep the shipment and all of its packaging as they are. We can't accept a damage complaint once the packaging has been thrown away.",
          'To report it, please send us these as soon as you can:',
          '1. Photos of the product showing the damage\n2. Photos of the packaging\n3. The tracking number',
          "Once I have these, I'll raise the complaint with the team responsible. Replacements and refunds are arranged directly with the store, so it's worth contacting them too.",
        ],
      }),
      reply('condition.wrong_or_missing_recipient', 'Wrong or missing items (recipient)', {
        ar: [
          'يؤسفنا أن طلب حضرتك لم يصل كما كان متوقعًا. المتجر هو الذي جهّز الطلب وغلّفه، ونحن نوصّل الشحنة كما استلمناها منه، لذلك فإن أسرع طريقة لحل مشكلة منتج ناقص أو مختلف عن المطلوب هي التواصل مع المتجر مباشرةً.',
          'أما إذا بدا التغليف مفتوحًا أو كانت عليه آثار عبث عند الاستلام، فنرجو من حضرتك الاحتفاظ به وإرسال صور له مع رقم تتبع الشحنة، وسأراجع الأمر من جانبنا أيضًا.',
        ],
        en: [
          "I'm sorry your order didn't arrive as expected. The store prepared and packed your order, and we deliver the shipment as it was handed to us. Contacting the store is the quickest way to sort out a wrong or missing item.",
          "If the packaging looked opened or tampered with when it arrived, please keep it. Send us photos of the packaging and the tracking number, and I'll look into it on our side too.",
        ],
      }),
      reply('condition.damage_claim_merchant', 'Damage claim (merchant) — what we need', {
        ar: [
          'يؤسفنا وصول أحد أوردرات حضرتك متضررًا. ويجب الإبلاغ عن الأوردرات المتضررة خلال 24 ساعة من تاريخ التسليم، في موعد أقصاه الساعة 6 مساءً من يوم العمل التالي.',
          'ولفتح تحقيق في الأمر، يُرجى إرسال:',
          '1. رقم التتبع\n2. صور لتغليف الأوردر\n3. صور تُظهر التلف بوضوح',
          'ويُشترط لقبول شكوى التلف أن يكون الأوردر مسجّلًا في نظام شيب بلو على أنه قابل للكسر (Fragile)، وأن يحمل ملصق «Fragile» واضحًا على التغليف الخارجي، وأن يكون مغلّفًا وفقًا لإرشادات التغليف الخاصة بنا. كما لا تتحمل شيب بلو مسؤولية التلف الذي يحدث للأوردرات المسموح بفتحها (Allow to Open) أثناء فتحها أو بعده.',
        ],
        en: [
          'Sorry to hear one of your orders arrived damaged. Damage needs to be reported within 24 hours of the delivery date, and no later than 6 PM on the next business day.',
          'To open an investigation, please send us:',
          "1. The tracking number\n2. Photos of the order's packaging\n3. Photos that clearly show the damage",
          'A damage claim is valid only if the order was marked "Fragile" in the ShipBlu system and had a visible "Fragile" label on its outer packaging. It also needs to have been packed according to our packaging guidelines. ShipBlu also isn\'t liable for damage to an "Allow to Open" order that happens during or after opening.',
        ],
      }),
    ],
  },
  // ── Returns and refunds ───────────────────────────────────────────────────────
  // Both directions of a return, and the two refund paths that exist.
  {
    name: 'Returns and refunds',
    responses: [
      reply('returns.after_delivery_recipient', 'Return or refund after delivery (recipient)', {
        ar: [
          'بمجرد تسليم الشحنة، يُحوَّل أي مبلغ محصَّل إلى المتجر تلقائيًا، لذلك لا يمكننا رد قيمة الطلب بعد تسليمه. ولطلب الإرجاع أو الاستبدال أو استرداد المبلغ، نرجو من حضرتك التواصل مع المتجر الذي تم الشراء منه، لأنه يتولى ترتيب ذلك مباشرةً.',
          'وإذا طلب المتجر منا استلام المنتج المرتجع، فسيحضر مندوبنا لأخذه من حضرتك.',
        ],
        en: [
          "Once a shipment is delivered, any amount collected is transferred to the store automatically, so we can't refund an order after delivery. For a return, exchange or refund, please contact the store you bought from, as they arrange these directly.",
          'If the store books a return pickup with us, our courier will collect the item from you.',
        ],
      }),
      reply('returns.cancel_recipient', 'Cancel an order before delivery (recipient)', {
        ar: [
          'لإلغاء الطلب، نرجو من حضرتك التواصل مباشرةً مع المتجر الذي تم الشراء منه، فهو الذي يدير الطلب، ولا يمكن إلغاؤه إلا من خلاله.',
          'وإذا وصلت الشحنة قبل أن يلغي المتجر الطلب، يمكن لحضرتك رفض استلامها عند اتصال المندوب أو عند وصوله، وستعود الشحنة إلى المتجر. وإذا كان المتجر قد حدّد رسوم توصيل تُدفع عند رفض الشحنة، فسيطلب المندوب تحصيلها.',
        ],
        en: [
          'To cancel the order, please get in touch with the store you bought from. The store manages the order, so only they can cancel it.',
          "If the shipment reaches you before the store cancels the order, you can decline it when the courier calls or arrives, and it'll be returned to the store. If the store has set a delivery fee for refused shipments, the courier will ask for it.",
        ],
      }),
      reply('returns.cancel_merchant', 'Cancel an order — Return to Origin (merchant)', {
        ar: [
          'لإلغاء أوردر استلمه مندوبنا بالفعل، يمكن لحضرتك استخدام لوحة تحكم شيب بلو كالتالي:',
          '1. الضغط على النقاط الثلاث تحت «خيارات» (Actions) بجانب الأوردر.\n2. اختيار «يعود إلى المتجر» (Return to Origin).',
          'وبعد ذلك سيعود الأوردر إلى عنوان الإرجاع المسجّل في حساب حضرتك، ويمكن متابعته من سجل حالة الأوردر.',
        ],
        en: [
          "To cancel an order we've already picked up, use your ShipBlu dashboard:",
          '1. Click the three dots under Actions next to the order.\n2. Choose "Return to Origin".',
          "The order will then be returned to your return point, and you can follow it in the order's timeline.",
        ],
      }),
      reply('returns.create_return_merchant', 'Return order — how to create one (merchant)', {
        ar: [
          'يمكن لحضرتك إنشاء أوردر إرجاع من لوحة تحكم شيب بلو كالتالي:',
          '1. الدخول إلى إنشاء أوردر (Create Order).\n2. اختيار أوردر إرجاع (Return Order).',
          'وبعد إنشائه، يمكن متابعته من سجل حالة الأوردر. أما إذا كان العميل يرغب في استبدال المنتج لا إرجاعه، فالخيار المناسب هو الاستبدال (Pickup to Exchange) من قائمة الأوردر الذي تم توصيله.',
        ],
        en: [
          'You can create a return order from your ShipBlu dashboard:',
          '1. Go to Create Order.\n2. Choose "Return Order".',
          'Once it\'s created, you can follow it in the order\'s timeline. If your customer is swapping the item rather than sending it back, use "Pickup to Exchange" on the delivered order instead.',
        ],
      }),
      reply('returns.status_merchant', 'Return status — where to follow it (merchant)', {
        ar: [
          'يمكن لحضرتك متابعة أي مرتجع من لوحة تحكم شيب بلو بفتح الأوردر ومراجعة سجل حالته، فهو يعرض كل تحديث حتى يعود الأوردر إلى حضرتك.',
          'ولمراجعة مرتجع معيّن، يُرجى إرسال رقم تتبعه، وسأتحقق من موقعه الحالي وأوافي حضرتك بالتحديث هنا.',
        ],
        en: [
          'You can follow any return in your ShipBlu dashboard: open the order, and its timeline shows each update on the way back to you.',
          "If you'd like me to check a specific return, send me its tracking number. I'll find out where it is and update you here.",
        ],
      }),
      reply('returns.not_received_merchant', 'Return not received — investigating (merchant)', {
        ar: [
          'يؤسفنا أن المرتجع لم يصل إلى حضرتك حتى الآن. فتحتُ تحقيقًا مع فريق العمليات لتتبّع مكانه، وسأعود إلى حضرتك هنا بما يتوصل إليه الفريق.',
          'وإذا كانت هناك مرتجعات أخرى لم تصل، يُرجى إرسال أرقام تتبعها لأضيفها إلى التحقيق نفسه.',
        ],
        en: [
          "I'm sorry the return hasn't reached you yet. I've opened an investigation with our operations team to trace it, and I'll come back to you here with what they find.",
          "If any other returns are missing, send me their tracking numbers and I'll add them to the same investigation.",
        ],
      }),
      reply('returns.exchange_merchant', 'Exchange — how to create one (merchant)', {
        ar: [
          'من لوحة تحكم شيب بلو، يمكن لحضرتك إنشاء طلب استبدال لأي أوردر تم توصيله كالتالي:',
          '1. الدخول إلى قائمة أوردرات التوصيل (Delivery Orders)، ثم الضغط على النقاط الثلاث بجانب الأوردر الذي تم توصيله.\n2. اختيار الاستبدال (Pickup to Exchange).\n3. إدخال بيانات الشحنة المرتجعة وبيانات الشحنة المطلوب توصيلها.\n4. تحديد أوردر الاستبدال، ثم الضغط على زر طلب الاستلام (Request Pickup).',
          'وتبدأ أرقام تتبع الاستبدال بالرقم 31 لشحنة التوصيل وبالرقم 32 لشحنة الإرجاع.',
        ],
        en: [
          'From your ShipBlu dashboard, you can create an exchange for any delivered order:',
          '1. Go to Delivery Orders and click the three dots next to the delivered order.\n2. Choose "Pickup to Exchange".\n3. Enter the details of the package to be returned and the package to be delivered.\n4. Select the exchange and click "Request Pickup".',
          'Exchange tracking numbers start with 31 for the delivery leg and 32 for the return leg.',
        ],
      }),
      reply('returns.refund_myblu', 'Refund — paid in myBlu, not delivered (recipient)', {
        ar: [
          'إذا كان الدفع قد تم من خلال تطبيق ماي بلو (myBlu) ولم تصل الشحنة، يمكن لحضرتك تقديم طلب استرداد المبلغ عبر النموذج المتاح في مركز المساعدة.',
          'تتم مراجعة الطلب بعد إرجاع الشحنة إلى المتجر، وهو ما يستغرق عادةً يوم عمل أو يومين من تاريخ رفض الاستلام أو آخر محاولة توصيل. ويُردّ المبلغ إلى وسيلة الدفع الأصلية فقط، وبعد أن نعالج الطلب، يظهر المبلغ في حساب حضرتك خلال 7 إلى 14 يومًا حسب البنك أو المحفظة الإلكترونية.',
        ],
        en: [
          "If you paid through the myBlu app and didn't receive the shipment, you can submit a refund request using the form in our help centre.",
          "We review your request once the shipment is back with the store, usually within 1 to 2 business days of the refusal or the last delivery attempt. The refund goes only to the original payment method. Once we've processed the refund, the amount appears within 7 to 14 days, depending on your bank or wallet.",
        ],
      }),
    ],
  },
  // ── Merchant pickups and supplies ─────────────────────────────────────────────
  // Merchants getting parcels to us.
  {
    name: 'Merchant pickups and supplies',
    responses: [
      reply('pickup.missed', 'Pickup missed — rescheduling as a priority', {
        ar: [
          'نعتذر لحضرتك عن عدم استلام الأوردرات في موعدها، ونتفهم أن ذلك يؤخر وصولها إلى عملاء حضرتك.',
          'رفعت الأمر إلى فريق العمليات وطلبت تحديد موعد استلام جديد بشكل عاجل، وسيتواصل المندوب مع حضرتك قبل وصوله. وسأؤكد لحضرتك هنا فور تحديد الموعد الجديد.',
        ],
        en: [
          "I'm sorry your orders weren't collected as planned. I understand this holds up deliveries to your customers.",
          "I've raised it with our operations team and asked them to reschedule the pickup as a priority. The courier will contact you before arriving, and I'll confirm here once the new pickup is booked.",
        ],
      }),
      reply('pickup.request', 'Pickup — how to request one', {
        ar: [
          'يمكن لحضرتك طلب استلام الأوردرات من لوحة تحكم شيب بلو بطريقتين:',
          '1. لكل أوردر على حدة، من خلال خيار طلب الاستلام (Request Pickup).\n2. لكل الأوردرات الجديدة، بتفعيل خيار الطلب التلقائي للاستلام والإرجاع والتحصيل (Automatic Pickup, Return, Collection Request) من إعدادات الحساب (Account Settings)، فيُطلب استلامها دون أي خطوة إضافية.',
          'وإذا تعذّر الاستلام في اليوم المحدد، تُعاد جدولته إلى يوم العمل التالي، ويتواصل المندوب مع حضرتك مرة أخرى.',
        ],
        en: [
          'You can request pickups from your ShipBlu dashboard in two ways:',
          '1. Order by order, using "Request Pickup" on each one.\n2. Automatically, by turning on "Automatic Pickup, Return, Collection Request" in Account Settings, so every new order is requested for you.',
          "If a pickup can't happen on the scheduled day, it's moved to the next business day and the courier will contact you again.",
        ],
      }),
      reply('pickup.point_change', 'Change pickup or return point — ask for address', {
        ar: [
          'يسعدني مساعدة حضرتك في تغيير عنوان الاستلام أو الإرجاع. يُرجى إرسال:',
          '1. العنوان الجديد كاملًا: المنطقة، والشارع، ورقم المبنى، والدور، وأقرب علامة مميزة\n2. اسم الشخص المسؤول عن التواصل في العنوان الجديد ورقم هاتفه',
          'وبمجرد وصول البيانات، سأتحقق من أن العنوان الجديد يقع ضمن نطاق تغطيتنا، وأنسّق التغيير مع الفريق المختص.',
        ],
        en: [
          'I can help you change your pickup or return point. Please send me:',
          '1. The full new address: area, street, building, floor and a nearby landmark\n2. The name and mobile number of the person to contact at the new location',
          "Once I have them, I'll check that the new address is within our coverage and arrange the change with the right team.",
        ],
      }),
      reply('pickup.supplies', 'Packaging materials — how to order', {
        ar: [
          'يمكن لحضرتك طلب مواد التغليف مباشرة من لوحة التحكم، من خلال متجر مواد التغليف (Supplies Shop). وبعد اختيار المواد المطلوبة، يكون الدفع بالبطاقة أو من رصيد شيب بلو (ShipBlu Balance).',
          'وتصل المواد إلى حضرتك خلال 24 إلى 48 ساعة عمل.',
        ],
        en: [
          'You can order packaging materials straight from your dashboard, in the "Supplies Shop". Choose what you need and pay by card or from your ShipBlu Balance.',
          'Your supplies will arrive within 24 to 48 working hours.',
        ],
      }),
      reply('pickup.fragile', 'Fragile items — how to ship them', {
        ar: [
          'لشحن المنتجات القابلة للكسر، يلزم في كل أوردر ثلاثة أمور:',
          '1. تحديد الأوردر على أنه قابل للكسر (Fragile) في نظام شيب بلو\n2. وضع ملصق واضح بعبارة «قابل للكسر» (Fragile) على التغليف الخارجي\n3. تغليف الأوردر وفق إرشادات شيب بلو للتغليف، المتاحة في مركز المساعدة',
          'وهذه الشروط مهمة أيضًا في حال حدوث أي تلف، إذ لا يُقبل بلاغ التلف إلا إذا استوفاها الأوردر.',
        ],
        en: [
          'To ship a fragile item with us, please:',
          '1. Mark the order "Fragile" in the ShipBlu system\n2. Put a visible "Fragile" label on the outer packaging\n3. Pack it following our packaging guidelines, which you\'ll find in the help centre',
          'This also matters if anything arrives damaged: a damage claim is only valid if all three steps have been followed.',
        ],
      }),
    ],
  },
  // ── Merchant finance ──────────────────────────────────────────────────────────
  // Payouts, statements, invoices and the wallet.
  {
    name: 'Merchant finance',
    responses: [
      reply('finance.payout_schedule', 'Payout schedule and statements', {
        ar: [
          'تُحوَّل مستحقات حضرتك وفق الدورة الأسبوعية المحددة للحساب، وتتحدد هذه الدورة حسب حجم الشحنات الشهري.',
          'ولمعرفة ما شمله كل تحويل، يمكن الدخول إلى قائمة الماليات (Finances) ثم الفواتير (Billing) في لوحة التحكم، ومن هناك يمكن تنزيل أي كشف حساب بصيغة Excel أو PDF.',
          'وإذا رغبت حضرتك في معرفة دورة التحويل المحددة للحساب، يمكنني التحقق منها.',
        ],
        en: [
          "Your payouts follow your account's weekly transfer cycle, which depends on your monthly shipping volume.",
          'To see what each transfer covered, open Finances, then Billing, in your dashboard. You can download any statement there as an Excel or PDF file.',
          "If you'd like to know which cycle your account is on, I can check it for you.",
        ],
      }),
      reply('finance.cod_limit', 'COD limit — EGP 10,000 per order', {
        ar: [
          'الحد الأقصى للمبلغ الذي نحصّله عند التسليم هو 10,000 جنيه مصري للأوردر الواحد، ونحصّله من عميل حضرتك نيابةً عن حضرتك، وفق المبلغ المحدد على الأوردر.',
          'كما لا يمكن شحن أي منتج تزيد قيمته على 10,000 جنيه مصري. والقائمة الكاملة لما لا يمكن شحنه متاحة في مركز المساعدة.',
        ],
        en: [
          'The most we can collect on delivery for a single order is EGP 10,000. We collect it from your customer on your behalf, and the amount is the one you set on the order.',
          "Items worth more than EGP 10,000 also can't be shipped with us. The full list of what can't be shipped is in our help centre.",
        ],
      }),
      reply('finance.payout_missing', 'Payout or collection missing — investigating', {
        ar: [
          'نتفهم قلق حضرتك بشأن هذا المبلغ، لذا رفعت الموضوع إلى فريق الماليات لمراجعة المبالغ ومطابقتها، وسأنقل إلى حضرتك ردّ الفريق هنا.',
          'وإن أمكن، نرجو إرسال أرقام تتبع الأوردرات التي كان من المتوقع أن يشملها التحويل، فذلك يساعد الفريق على تعقّب المبالغ بسرعة.',
          'وحتى ذلك الحين، يمكن لحضرتك الاطلاع على كشوف الحساب من قائمة الماليات (Finances) ثم الفواتير (Billing) في لوحة التحكم، وفيها يتضح ما شمله كل تحويل.',
        ],
        en: [
          "I understand how worrying a missing amount is, so I've raised it with our finance team to reconcile it. I'll share their answer with you here.",
          'If you can, please send the tracking numbers of the orders you expected the transfer to include. It helps the team trace the amounts quickly.',
          'In the meantime, the statements under Finances, then Billing, in your dashboard show what each transfer covered.',
        ],
      }),
      reply('finance.price_list', 'Price list — where to find it', {
        ar: [
          'يمكن لحضرتك الاطلاع على أسعار الشحن من لوحة التحكم، من قائمة الحساب (Account) ثم الأسعار (Pricing).',
          'وبعد إدخال حجم الشحنات الشهري، ونوع الأوردر، وعدد الطرود، يظهر متوسط رسوم الشحن.',
        ],
        en: [
          'You can see your price list in your dashboard under Account, then Pricing.',
          "Enter your monthly volume, the order type and the number of packages, and you'll see the average shipping fee.",
        ],
      }),
      reply('finance.tax_invoices', 'Tax invoices — company account details', {
        ar: [
          'للحصول على فواتير ضريبية، يلزم استكمال بيانات الحساب بصفته حساب شركة، باتباع الخطوات التالية:',
          '1. الدخول إلى قائمة «حسابي» (My Account) ثم بيانات الحساب (Account Details).\n2. اختيار «شركة» (Company) نوعًا للحساب، واستكمال بيانات الشركة.\n3. رفع البطاقة الضريبية.',
          'ومن المهم أن يتطابق الاسم القانوني (Legal Name) في الحساب تمامًا مع الاسم المسجل في البطاقة الضريبية، وأن يكون باللغة نفسها.',
          'وإذا كان نوع الحساب المحدد بالفعل هو «شخصي» (Personal)، فلا يمكن تغييره بعد الإرسال، لذا يُرجى إبلاغي بذلك، وسأبحث الأمر مع الفريق المختص.',
        ],
        en: [
          'To receive tax invoices, your account needs to be set up as a company:',
          '1. Go to My Account, then Account Details.\n2. Choose "Company" as the account type and fill in your company details.\n3. Upload your tax card.',
          'One thing to check: the Legal Name on the account must match the name on your tax card exactly, and in the same language.',
          "If your account type is already set to Personal, it can't be changed after submission, so let me know and I'll look into it with the team.",
        ],
      }),
      reply('finance.charge_dispute', 'Charge looks wrong — investigating', {
        ar: [
          'شكرًا لحضرتك على التنبيه. رفعت الأمر إلى فريق الماليات لمراجعة هذه الرسوم، وسأبلغ حضرتك بنتيجة المراجعة هنا.',
          'وإن أمكن، نرجو إرسال أرقام تتبع الأوردرات المعنية، فذلك يساعد الفريق على الوصول إلى الرسوم المقصودة بدقة وسرعة.',
        ],
        en: [
          "Thanks for flagging this. I've raised it with our finance team and asked them to review the charge, and I'll update you here once they've looked into it.",
          'If you can, please send the tracking numbers of the orders involved. It helps the team find the exact charges quickly.',
        ],
      }),
      reply('finance.wallet', 'Wallet — top up or withdraw', {
        ar: [
          'يمكن لحضرتك إدارة محفظة شيب بلو من لوحة التحكم، من قائمة الماليات (Finances) ثم نظرة عامة (Overview). وأسفل رصيد المحفظة (Wallet Balance) يظهر خياران:',
          '1. إيداع (Deposit): لإضافة رصيد إلى المحفظة عن طريق إنستاباي (InstaPay) أو التحويل البنكي أو البطاقة\n2. سحب (Withdraw): لسحب مبلغ من الرصيد',
        ],
        en: [
          "You can manage your ShipBlu wallet from your dashboard: open Finances, then Overview. Under Wallet Balance you'll find two options:",
          '1. "Deposit" to top up your balance, by InstaPay, bank transfer or card\n2. "Withdraw" to take money out of your balance',
        ],
      }),
    ],
  },
  // ── Merchant account and integrations ─────────────────────────────────────────
  // Signing up and connecting a store.
  {
    name: 'Merchant account and integrations',
    responses: [
      reply('account.signup', 'Sign-up — open a merchant account', {
        ar: [
          'يمكن لحضرتك فتح حساب تاجر على شيب بلو بخطوات بسيطة:',
          '1. الضغط على زر بدء الشحن (Start Shipping) على منصة شيب بلو.\n2. إدخال البيانات الشخصية.\n3. تأكيد الحساب برمز التحقق الذي يصل في رسالة نصية.',
          'وقبل طلب أي استلام، يلزم تحديد نوع الحساب: «شركة» (Company) أو «شخصي» (Personal). ونرجو اختيار النوع بعناية، لأنه لا يمكن تغييره بعد الإرسال. وفي حال الحاجة إلى فواتير ضريبية، فالنوع المناسب هو «شركة».',
        ],
        en: [
          'Opening a ShipBlu merchant account is simple:',
          '1. Choose "Start Shipping" on the ShipBlu platform.\n2. Enter your personal details.\n3. Confirm with the verification code we send you by SMS.',
          "Before you can request pickups, you'll need to set your account type: Company or Personal. Please choose carefully, as it can't be changed after you submit it. If you'll need tax invoices, choose Company.",
        ],
      }),
      reply('integration.connect', 'Store integration — how to connect', {
        ar: [
          'يمكن لحضرتك ربط المتجر الإلكتروني بحساب شيب بلو، إذ نوفر الربط مع منصات Shopify، وWooCommerce، وMagento، وZammit، بالإضافة إلى الربط عبر واجهة برمجة التطبيقات (API).',
          'ولكل منصة دليل خطوة بخطوة في مركز المساعدة. على أي منصة يعمل متجر حضرتك؟ وسأرسل الدليل المناسب لها.',
        ],
        en: [
          'You can connect your online store to your ShipBlu account. We integrate with Shopify, WooCommerce, Magento and Zammit, and we also offer an API.',
          "Each platform has its own step-by-step guide in our help centre. Which platform is your store on? I'll send you the right guide.",
        ],
      }),
      reply('integration.sync_issue', 'Store integration — orders not syncing', {
        ar: [
          'يؤسفنا توقّف وصول الأوردرات إلى حساب شيب بلو. وحتى يتمكن فريقنا التقني من فحص المشكلة، يُرجى إرسال:',
          '1. اسم المنصة التي يعمل عليها المتجر\n2. التاريخ التقريبي الذي توقفت فيه مزامنة الأوردرات\n3. رقمين أو ثلاثة من أرقام أوردرات المتجر التي لم تصل إلى حساب شيب بلو\n4. لقطة شاشة لأي رسالة خطأ ظهرت',
          'وبمجرد وصول هذه البيانات، سأحيلها إلى الفريق التقني وأبلغ حضرتك بأي جديد هنا.',
        ],
        en: [
          "Sorry to hear your orders aren't coming through. To help our technical team look into it, please send me:",
          "1. The platform your store is on\n2. Roughly when the orders stopped syncing\n3. Two or three order numbers from your store that didn't reach your ShipBlu account\n4. A screenshot of any error message you've seen",
          "As soon as I have these, I'll pass them on and update you here.",
        ],
      }),
    ],
  },
  // ── Sales enquiries ───────────────────────────────────────────────────────────
  // Prospects who have not signed up — a sales lead sitting in the support queue.
  {
    name: 'Sales enquiries',
    responses: [
      reply('sales.rates', 'Rates before signing up', {
        ar: [
          'يسعدنا اهتمام حضرتك بخدمات شيب بلو. تختلف أسعارنا حسب حجم الشحنات ومناطق التوصيل، ولإعداد عرض يناسب نشاط حضرتك، يُرجى إرسال:',
          '1. العدد المتوقع للشحنات شهريًا\n2. منطقة الاستلام\n3. أهم مناطق التوصيل\n4. متوسط حجم الشحنة ووزنها',
          'وسأحيل البيانات إلى فريق المبيعات لإعداد العرض. ويمكن لحضرتك أيضًا فتح حساب تاجر في أي وقت، ثم معرفة متوسط رسوم الشحن من قائمة الحساب (Account) ثم الأسعار (Pricing) بعد إدخال حجم الشحنات.',
        ],
        en: [
          'Thanks for considering ShipBlu. Our prices depend on your shipping volume and destinations. To help our sales team prepare an offer that fits your business, please send me:',
          "1. Your expected number of shipments per month\n2. The area we'd pick up from\n3. Your main delivery areas\n4. The typical size and weight of your shipments",
          "I'll pass these on to the team. You can also open a merchant account at any time and see the average shipping fee for your volume under Account, then Pricing.",
        ],
      }),
      reply('sales.coverage', 'Is my area covered?', {
        ar: [
          'تتوفر في مركز المساعدة القائمة الكاملة بالمناطق التي نخدمها والمناطق التي لا تشملها خدمتنا.',
          'ويمكن لحضرتك أيضًا إرسال اسم المنطقة هنا، وسأتحقق من تغطيتها.',
        ],
        en: [
          "You'll find the full list of the areas we serve, and those we don't, in our help centre.",
          "If you'd rather, tell me the area you have in mind and I'll check it for you.",
        ],
      }),
      reply('sales.forbidden', "Prohibited items — what can't be shipped", {
        ar: [
          'لا يمكن شحن بعض المنتجات عبر شيب بلو، ومنها: الحيوانات والنباتات الحية، والأطعمة والمشروبات سريعة التلف، والمشروبات الكحولية والتبغ، والمتفجرات والمواد القابلة للاشتعال، والأسلحة والأدوات الخطرة، والمخدرات والأدوية غير المرخصة، والعملات النقدية والشيكات والمستندات الأصلية ذات القيمة، وأي شيء مخالف للقانون في مصر.',
          'كما لا يمكن شحن أي شيء تزيد قيمته على 10,000 جنيه مصري. والقائمة الكاملة متاحة في مركز المساعدة.',
        ],
        en: [
          "Some items can't be shipped with ShipBlu, including live animals and plants, perishable food and drinks, alcohol and tobacco, and explosives and flammable materials. Weapons and dangerous tools, narcotics and unlicensed medicines, currency, cheques and original documents of value are also excluded, as is anything illegal in Egypt.",
          "We also can't accept anything worth more than EGP 10,000. The full list is in our help centre.",
        ],
      }),
    ],
  },
  // ── Social and other ──────────────────────────────────────────────────────────
  // Public comments, and messages that are not support at all.
  {
    name: 'Social and other',
    responses: [
      reply('social.public_to_private', 'Public comment — moved to private messages', {
        ar: [
          'نأسف لما حدث، وقد أرسلنا لحضرتك رسالة خاصة حتى نتابع الأمر دون مشاركة أي بيانات شخصية في التعليقات. يُرجى مراجعة الرسائل الخاصة، وسنستكمل التواصل هناك.',
        ],
        en: [
          "We're sorry to hear this. We've sent you a private message so we can look into it without sharing any personal details here. Please check your messages, and we'll take it from there.",
        ],
      }),
      reply('other.job_application', 'Job applications', {
        ar: [
          'شكرًا لاهتمام حضرتك بالانضمام إلى فريق شيب بلو. هذه القناة مخصصة لخدمة العملاء فقط، لذا لا نراجع طلبات التوظيف التي تصل عبرها.',
          'نعلن عن الوظائف المتاحة عبر صفحات شيب بلو الرسمية، فهي أفضل مكان لمتابعة فرص العمل لدينا، ونتمنى لحضرتك كل التوفيق.',
        ],
        en: [
          "Thank you for your interest in joining ShipBlu. This channel is for customer support only, so job applications sent here aren't reviewed.",
          "Open roles are announced on ShipBlu's official pages, which are the best place to look for opportunities. Good luck with your search.",
        ],
      }),
      reply('other.partnership', 'Partnership, courier and vendor offers', {
        ar: [
          'نقدّر تواصل حضرتك مع شيب بلو بخصوص العمل معًا. هذه القناة مخصصة لخدمة العملاء، لذا حوّلتُ الرسالة إلى الفريق المختص، وسيتواصل مع حضرتك في حال وجود فرصة مناسبة للتعاون.',
        ],
        en: [
          "We appreciate you reaching out about working with ShipBlu. This channel is for customer support, so I've passed your message to the right team. They'll get in touch if there's a fit.",
        ],
      }),
    ],
  },
  // ── Automatic acknowledgement ─────────────────────────────────────────────────
  // Safe to send unattended: no time, no promise, any channel, any message.
  {
    name: 'Automatic acknowledgement',
    responses: [
      reply('ack.received', "We've received your message", {
        ar: [
          'شكرًا لتواصل حضرتك مع شيب بلو. وصلتنا رسالة حضرتك، وسيرد عليها أحد أعضاء فريقنا في أقرب وقت ممكن.',
          'وإذا كانت الرسالة بخصوص شحنة، فرقم التتبع يساعدنا على مراجعتها بشكل أسرع. وحفاظًا على خصوصية حضرتك، يُرجى مشاركته معنا في رسالة خاصة فقط، وليس في تعليق عام.',
        ],
        en: [
          "Thanks for contacting ShipBlu. We've received your message, and a member of our team will reply as soon as possible.",
          "If it's about a shipment, its tracking number will help us look into it faster. For your privacy, please share it only in a private message, never in a public comment.",
        ],
      }),
    ],
  },
];
