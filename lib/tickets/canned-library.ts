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
          'وإذا كان الاستفسار بخصوص شحنة، فإرسال رقم التتبع الخاص بها سيساعدني على متابعتها بشكل أسرع.',
        ],
        en: [
          'Hi, and welcome to ShipBlu support. How can I help you today?',
          'If your question is about a shipment, sending its tracking number will help me look into it faster.',
        ],
      }),
      reply('general.ask_tracking_number', 'Ask for the tracking number', {
        ar: [
          'نرجو من حضرتك إرسال رقم التتبع الخاص بالشحنة، فهو ما يمكّنني من الوصول إليها في نظامنا ومعرفة موقعها الحالي بدقة.',
          'يمكن لحضرتك إيجاد رقم التتبع عادةً في الرسالة النصية (SMS) الواردة من شيب بلو، أو في رسالة تأكيد الطلب من المتجر.',
        ],
        en: [
          "Could you send me your shipment's tracking number? It lets me find the shipment in our system and check exactly where it is.",
          "You'll usually find it in the text message from ShipBlu, or in the order confirmation from the store.",
        ],
      }),
      reply('general.ask_details', 'Ask for more details', {
        ar: [
          'أودّ أن أفهم الموقف بدقة حتى أتمكن من مساعدة حضرتك بالشكل الصحيح، لذا نرجو توضيح ما حدث بمزيد من التفاصيل.',
          'وإذا كانت لدى حضرتك صورة أو لقطة شاشة للمشكلة، فيُرجى إرسالها أيضًا. وإن كان الأمر يخص شحنة، فرقم التتبع سيساعدني على مراجعتها فورًا.',
        ],
        en: [
          'I want to make sure I understand exactly what happened so I can help properly. Could you tell me a little more about it?',
          'If you have a screenshot or a photo, please send it too. And if this is about a shipment, the tracking number will let me look it up straight away.',
        ],
      }),
      reply('general.checking', "Checking now — I'll update you shortly", {
        ar: [
          'شكرًا لانتظار حضرتك. أراجع الأمر الآن، وسأعود إلى حضرتك هنا بالمستجدات خلال وقت قصير.',
        ],
        en: ["Thanks for waiting. I'm looking into this now and will update you here shortly."],
      }),
      reply('general.follow_up', 'Follow-up — waiting on the customer', {
        ar: [
          'أتابع مع حضرتك بخصوص رسالتي السابقة، إذ لم يصلنا رد حتى الآن، وما زلنا بحاجة إلى المعلومات المطلوبة حتى نتمكن من المتابعة.',
          'ويسعدني استكمال مساعدة حضرتك فور وصول الرد هنا في هذه المحادثة.',
        ],
        en: [
          "I'm following up on my earlier message, as I haven't heard back yet. I still need the details I asked for to move this forward.",
          "Whenever you're ready, just reply here and I'll be happy to pick up where we left off.",
        ],
      }),
      reply('general.anything_else', 'Anything else I can help with?', {
        ar: ['هل هناك أي شيء آخر يمكنني مساعدة حضرتك فيه؟'],
        en: ['Is there anything else I can help you with today?'],
      }),
      reply('general.resolved', "Closing — glad it's sorted", {
        ar: [
          'يسعدني أن الأمر قد تم حله، وأشكر حضرتك على الصبر والتعاون طوال المتابعة.',
          'وإذا كان هناك أي استفسار آخر، فيمكن لحضرتك الرد على هذه المحادثة، وسيسعدنا تقديم المساعدة.',
        ],
        en: [
          "I'm glad we got this sorted, and thank you for your patience along the way.",
          "If anything else comes up, just reply to this conversation and we'll be happy to help.",
        ],
      }),
      reply('general.praise', 'Thanks for the kind words', {
        ar: [
          'شكرًا جزيلًا لحضرتك على هذه الكلمات الطيبة، فهي تعني لنا الكثير، وسأحرص على مشاركة رسالة حضرتك مع الفريق.',
          'ويسعدنا دائمًا خدمة حضرتك.',
        ],
        en: [
          "Thank you so much for your kind words. It means a lot to us, and I'll be sure to share your message with the team.",
          "We're always happy to help.",
        ],
      }),
      reply('general.human', "Asked for a human — you're talking to a person", {
        ar: [
          'مع حضرتك الآن أحد أعضاء فريق خدمة عملاء شيب بلو، وهذا ليس ردًا آليًا.',
          'كيف يمكنني مساعدة حضرتك؟',
        ],
        en: [
          "You're chatting with a real person, a member of the ShipBlu support team, not an automated reply.",
          'How can I help you today?',
        ],
      }),
      reply('general.slow_reply', 'Sorry for the slow reply', {
        ar: [
          'نعتذر لحضرتك عن التأخر في الرد، وشكرًا على المتابعة. أراجع الأمر الآن، وسأوافي حضرتك بالمستجدات هنا أولًا بأول.',
        ],
        en: [
          "I'm sorry it's taken us a while to get back to you, and thanks for following up. I'm looking into this now and will keep you updated right here.",
        ],
      }),
      reply('general.complaint', "Complaint received — I've escalated it", {
        ar: [
          'شكرًا لحضرتك على إبلاغنا، ونعتذر عن تجربة لم تكن بالمستوى الذي يليق بحضرتك. نتفهم تمامًا مدى الإزعاج الذي سببه هذا الموقف.',
          'قمت برفع شكوى حضرتك إلى الفريق المسؤول لمراجعة ما حدث، وسأوافي حضرتك بالمستجدات هنا فور وصول ردهم.',
        ],
        en: [
          "Thank you for telling us about this, and I'm sorry your experience wasn't what it should have been. I understand how frustrating this is.",
          "I've raised your complaint with the team responsible so they can look into what happened, and I'll update you here as soon as I hear back from them.",
        ],
      }),
      reply('general.handover', 'Passed to the specialist team', {
        ar: [
          'قمت بتحويل طلب حضرتك إلى الفريق المختص بمتابعته، وسنوافي حضرتك بالمستجدات هنا في المحادثة نفسها، لذا لا داعي لإعادة إرساله.',
        ],
        en: [
          "I've passed your request to the team that handles this, so it's now with the right people. We'll update you right here in this conversation, so there's no need to send it again.",
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
          'يمكن لحضرتك متابعة الشحنة في أي وقت برقم التتبع من خلال صفحة التتبع في مركز المساعدة الخاص بنا.',
          'وللمتابعة لحظة بلحظة، يتوفر تطبيق ماي بلو (myBlu) على أندرويد وآيفون، ويمكن العثور عليه بالبحث عن «ShipBlu» أو «myBlu». ويكون تسجيل الدخول برقم الموبايل الذي أُرسلت إليه رسالة الشحنة، مع رمز التحقق الذي يصل إليه.',
          'وإذا كان الأسهل لحضرتك، يمكن إرسال رقم التتبع هنا وسأراجع حالة الشحنة بنفسي.',
        ],
        en: [
          'You can follow your shipment at any time with its tracking number on the tracking page in our help centre.',
          'For real-time updates, there\'s the myBlu app on Android and iPhone. Search for "ShipBlu" or "myBlu" in your app store, then log in with the mobile number that received the shipment text message and the verification code sent to it.',
          "If it's easier, send me the tracking number here and I'll check on your shipment myself.",
        ],
      }),
      reply('delivery.out_for_delivery', 'Out for delivery today', {
        ar: [
          'يسعدني إبلاغ حضرتك بأن الشحنة خرجت للتوصيل اليوم، وهي الآن مع المندوب.',
          'مواعيد التوصيل من الساعة 10 صباحًا حتى 7 مساءً، وقد تمتد قليلًا في مواسم الذروة. وسيتصل المندوب بحضرتك قبل الوصول للتنسيق، لذا نرجو أن يكون الهاتف قريبًا ومتاحًا للرد.',
        ],
        en: [
          'Good news: your shipment is out for delivery today and is already with the courier.',
          'Deliveries run from 10 AM to 7 PM, and can run a little later during peak seasons. The courier will call you before arriving, so please keep your phone close and reachable.',
        ],
      }),
      reply('delivery.in_transit', 'On its way — not out for delivery yet', {
        ar: [
          'الشحنة في طريقها الآن عبر شبكتنا إلى مركز التوزيع الذي يخدم منطقة حضرتك، ولم تخرج للتوصيل بعد.',
          'وبمجرد خروجها للتوصيل ستصل إلى حضرتك رسالة نصية، ثم يتصل المندوب للتنسيق قبل الوصول. وحتى ذلك الحين، يمكن متابعة كل تحديث على الشحنة لحظة بلحظة من خلال تطبيق ماي بلو (myBlu).',
        ],
        en: [
          "Your shipment is on its way through our network to the hub that serves your area. It hasn't gone out for delivery yet.",
          "Once it does, you'll get a text message, and the courier will call you before arriving. In the meantime, you can follow every update in real time in the myBlu app.",
        ],
      }),
      reply('delivery.late', 'Delivery is late — escalated', {
        ar: [
          'نعتذر لحضرتك عن هذا التأخير في توصيل الشحنة، ونتفهم تمامًا مدى الإزعاج الذي يسببه الانتظار.',
          'رفعت الأمر إلى فريق العمليات وطلبت إعطاء الشحنة الأولوية، وسأتابعها بنفسي وأبلغ حضرتك بأي جديد هنا في هذه المحادثة.',
        ],
        en: [
          "I'm sorry your shipment is taking longer than it should, and I understand how frustrating the wait is.",
          "I've raised it with our operations team and asked them to prioritise it. I'll keep following it and update you here in this conversation.",
        ],
      }),
      reply('delivery.attempt_disputed', 'Attempt recorded but no one came', {
        ar: [
          'نعتذر لحضرتك عن هذا الإزعاج، وشكرًا على إبلاغنا بأن أحدًا لم يحضر رغم تسجيل محاولة توصيل على الشحنة.',
          'أبلغت فريق العمليات بالأمر لمراجعة ما حدث، ورتبت محاولة توصيل جديدة للشحنة. وسيتصل المندوب بحضرتك قبل الوصول، لذا نرجو أن يكون الهاتف متاحًا للرد.',
        ],
        en: [
          "I'm sorry for the trouble, and thank you for letting us know that nobody came, even though a delivery attempt was recorded.",
          "I've reported this to our operations team so they can look into what happened, and I've arranged another delivery attempt for your shipment. The courier will call you before arriving, so please keep your phone reachable.",
        ],
      }),
      reply('delivery.no_call', "Courier didn't call", {
        ar: [
          'نعتذر لحضرتك عن عدم اتصال المندوب للتنسيق مسبقًا، فالاتصال قبل الوصول خطوة أساسية في كل عملية توصيل.',
          'نقلت هذه الملاحظة إلى فريق العمليات، وطلبت أن يتصل المندوب بحضرتك قبل المحاولة التالية.',
          'وإذا كان رقم الهاتف المسجل على الشحنة قد تغيّر، يُرجى إرسال الرقم الصحيح هنا وسأنقله إلى الفريق أيضًا.',
        ],
        en: [
          "I'm sorry the courier didn't call you first. Calling ahead to arrange the timing is a standard step in every delivery.",
          "I've passed your feedback to our operations team and asked for the courier to call you before the next attempt.",
          "If the phone number on your shipment might have changed, send me the right one and I'll pass it on too.",
        ],
      }),
      reply('delivery.reschedule_done', 'New delivery date confirmed', {
        ar: [
          'نقلت إلى فريق التوصيل اليوم الذي حددته حضرتك لاستلام الشحنة، وفي هذا اليوم سيتصل المندوب قبل الوصول.',
          'وإذا طرأ أي تغيير على مواعيد حضرتك، يمكن اختيار موعد توصيل آخر مباشرةً من خلال تطبيق ماي بلو (myBlu).',
        ],
        en: [
          "All set. I've passed the date you asked for to our delivery team, and the courier will call you on that day before arriving.",
          'If your plans change, you can choose a different delivery date yourself in the myBlu app.',
        ],
      }),
      reply('delivery.address_ask', 'Change address — ask for the new address', {
        ar: [
          'يسعدني تعديل عنوان التوصيل. يُرجى إرسال العنوان الجديد كاملًا، على أن يشمل:',
          '1. المنطقة واسم الشارع\n2. رقم المبنى والدور ورقم الشقة\n3. علامة مميزة قريبة\n4. رقم هاتف يمكن للمندوب التواصل مع حضرتك عليه',
          'ويمكن لحضرتك أيضًا تعديل العنوان مباشرةً من خلال تطبيق ماي بلو (myBlu) إذا كان ذلك أسهل.',
        ],
        en: [
          'I can update the delivery address for you. Please send the full new address, with:',
          '1. Area and street name\n2. Building number, floor and apartment\n3. A nearby landmark\n4. A phone number the courier can reach you on',
          "You can also change the address yourself in the myBlu app if that's easier.",
        ],
      }),
      reply('delivery.address_done', 'Change address — updated', {
        ar: [
          'نقلت العنوان الجديد إلى فريق التوصيل، وستصل الشحنة إليه بدلًا من العنوان السابق. وكالمعتاد، سيتصل المندوب بحضرتك قبل الوصول.',
          'وإذا كان العنوان الجديد في منطقة مختلفة، فقد يستغرق التوصيل وقتًا أطول قليلًا.',
        ],
        en: [
          "I've passed your new address to our delivery team, so your shipment will now be delivered there. As usual, the courier will call you before arriving.",
          'If the new address is in a different area from the original one, delivery may take a little longer.',
        ],
      }),
      reply('delivery.access_note', 'Access instructions passed to the courier', {
        ar: [
          'شكرًا لحضرتك على هذه التفاصيل. أضفت الملاحظة إلى بيانات الشحنة ليطّلع عليها المندوب قبل التوجه إلى حضرتك.',
          'كما سيتصل المندوب قبل الوصول لتأكيد أي تفاصيل في يوم التوصيل. ولإضافة ملاحظات أخرى لاحقًا، يمكن لحضرتك استخدام تطبيق ماي بلو (myBlu) مباشرةً.',
        ],
        en: [
          "Thanks, that's really helpful. I've added your note to your shipment so the courier sees it before heading to you.",
          "The courier will also call before arriving, in case anything needs confirming on the day. If you'd like to add more notes later, you can do that yourself in the myBlu app.",
        ],
      }),
      reply('delivery.marked_delivered', 'Marked delivered but not received', {
        ar: [
          'نعتذر لحضرتك، ونتفهم تمامًا القلق من ظهور الشحنة على أنها سُلِّمت وهي لم تصل بعد. ونتعامل مع هذا الأمر بكل جدية.',
          'نرجو أولًا السؤال لدى أفراد الأسرة أو الجيران أو حارس العقار، فربما استلمها أحدهم نيابةً عن حضرتك.',
          'وفي الوقت نفسه، فتحت تحقيقًا مع فريق العمليات، وسأبلغ حضرتك بأي جديد هنا في هذه المحادثة.',
        ],
        en: [
          "I'm sorry, and I understand how worrying it is to see your shipment marked as delivered when it hasn't reached you. We're taking this seriously.",
          "First, could you check with family members, neighbours or your building's security, in case someone received it on your behalf?",
          "In the meantime, I've opened an investigation with our operations team, and I'll update you here as soon as I hear back.",
        ],
      }),
      reply('delivery.refuse', 'Refusing the parcel', {
        ar: [
          'لا مشكلة. يمكن لحضرتك رفض استلام الشحنة عند اتصال المندوب أو عند وصوله، وستعود الشحنة إلى المتجر الذي أرسلها.',
          'وتختار بعض المتاجر تحصيل رسوم توصيل في حال رفض الشحنة، لتغطية تكلفة الشحن. فإذا كان المتجر قد حدد هذه الرسوم، فسيطلبها المندوب عند الرفض.',
          'أما إلغاء الطلب نفسه، أو استرداد المبلغ في حال الدفع للمتجر مقدمًا، فيتم ترتيبهما مع المتجر مباشرةً، لأنه صاحب الطلب.',
        ],
        en: [
          'No problem. You can decline the shipment when the courier calls or arrives, and it will be returned to the store that sent it.',
          'Some stores choose to have a delivery fee collected when a parcel is refused, to cover the delivery cost. If the store has set one for this order, the courier will ask for it.',
          'To cancel the order itself, or to get your money back if you paid the store in advance, please contact the store directly, since they handle cancellations and refunds for their orders.',
        ],
      }),
      reply('delivery.unrecognised', "Doesn't recognise the parcel", {
        ar: [
          'شيب بلو شركة شحن تتولى توصيل الطلبات نيابةً عن المتاجر الإلكترونية، وهذه الشحنة أرسلها متجر سجّل اسم حضرتك ورقم الهاتف على الطلب.',
          'ولمعرفة اسم المتجر، يمكن سؤال المندوب عند اتصاله، أو الاطلاع على الرسالة النصية الخاصة بالشحنة أو على تطبيق ماي بلو (myBlu)، حيث يظهر اسم المرسل.',
          'وإذا لم يكن هذا الطلب من حضرتك، يمكن رفض استلام الشحنة عند الباب، وستعود إلى المتجر.',
        ],
        en: [
          'ShipBlu delivers parcels on behalf of online stores. This shipment was sent by a store that has your name and phone number on the order.',
          "To find out which store it's from, you can ask the courier when they call, or check the shipment's text message or the myBlu app, which show the sender.",
          "If you didn't order anything, you can refuse the parcel at the door and it will go back to the store.",
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
          'المبلغ المطلوب عند الاستلام يحدده المتجر صاحب الطلب، وتحصّله شيب بلو نيابةً عنه، لذلك لا نملك صلاحية تعديله.',
          'وإذا بدا المبلغ غير صحيح، نرجو من حضرتك التواصل مع المتجر للتأكد منه قبل استلام الشحنة.',
          'وبعد التسليم يُحوَّل المبلغ المحصَّل إلى المتجر تلقائيًا، لذا لا يمكننا رده، ويتم ترتيب أي استرداد مع المتجر مباشرةً.',
        ],
        en: [
          "The amount due on delivery is set by the store you ordered from. ShipBlu collects it on the store's behalf, so we're not able to change it.",
          "If the amount doesn't look right, please check with the store before accepting the shipment.",
          "Once a shipment is delivered, the amount collected is transferred to the store automatically, so we can't refund it. Any refund is arranged with the store directly.",
        ],
      }),
      reply('payment.fod', 'Delivery fee on refusal (FOD)', {
        ar: [
          'الرسوم التي طلبها المندوب من حضرتك عند رفض الشحنة هي رسوم توصيل يحددها المتجر؛ إذ تختار بعض المتاجر تحصيلها عند الرفض لتغطية تكلفة التوصيل.',
          'والمتجر هو الذي يقرر تطبيق هذه الرسوم ويحدد قيمتها، ويحصّلها المندوب نيابةً عنه. ولأي استفسار بخصوصها، يُرجى التواصل مع المتجر مباشرةً.',
        ],
        en: [
          'The fee the courier asked for when you refused the parcel is a delivery fee set by the store. Some stores choose to have it collected when a parcel is refused, to cover the cost of delivering it.',
          "The store decides whether to charge it and sets the amount; our courier collects it on the store's behalf. If you have any questions about the fee, the store is the right place to ask.",
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
          'يؤسفنا سماع ذلك، وقد أرسلنا لحضرتك رسالة خاصة حتى نتمكن من متابعة الأمر دون مشاركة أي بيانات شخصية في التعليقات. وسنستكمل المتابعة مع حضرتك هناك.',
        ],
        en: [
          "We're sorry to hear this. We've sent you a private message so we can look into it without sharing any personal details in the comments, and we'll take it from there.",
        ],
      }),
      reply('other.job_application', 'Job applications', {
        ar: [
          'شكرًا لاهتمام حضرتك بالانضمام إلى فريق شيب بلو. هذه القناة مخصصة لخدمة العملاء فقط، لذا لا تتم مراجعة طلبات التوظيف التي تصل عبرها.',
          'نعلن عن الوظائف المتاحة لدينا عبر صفحات شيب بلو الرسمية، ونتمنى لحضرتك كل التوفيق.',
        ],
        en: [
          "Thank you for your interest in joining ShipBlu. This channel is for customer support only, so job applications sent here aren't reviewed.",
          "We announce open roles on ShipBlu's official pages, so that's the best place to look for opportunities. We wish you the best of luck.",
        ],
      }),
      reply('other.partnership', 'Partnership, courier and vendor offers', {
        ar: [
          'شكرًا لحضرتك على التواصل والاهتمام بالعمل مع شيب بلو. هذه القناة مخصصة لخدمة العملاء، لذا قمت بتحويل رسالة حضرتك إلى الفريق المختص، وسيتواصل مع حضرتك في حال وجود فرصة مناسبة للتعاون.',
        ],
        en: [
          "Thank you for reaching out and for your interest in working with ShipBlu. This channel is for customer support, so I've passed your message to the team concerned, and they'll get in touch if there's a fit.",
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
          'وإذا كانت الرسالة بخصوص شحنة، فوجود رقم التتبع يساعدنا على مراجعتها بشكل أسرع، لذا يُرجى إرساله هنا إن لم يكن ضمن الرسالة.',
        ],
        en: [
          "Thanks for contacting ShipBlu. We've received your message, and a member of our team will reply as soon as possible.",
          "If it's about a shipment and the tracking number isn't in your message yet, sending it here will help us look into it faster.",
        ],
      }),
    ],
  },
];
