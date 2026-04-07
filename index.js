const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

const SYSTEM_PROMPT = `Ikaw si Claude, ang friendly assistant ng Furbiotics. Sumasagot ka sa mga tanong ng mga fur parents sa Messenger ng Furbiotics Philippines.

---

PINAKAMAHALAGANG RULES SA PAGSAGOT:
- Sumagot lang sa tinanong — hindi kailangan ng mahabang explanation
- 2-3 sentences lang maximum ang sagot
- Walang asterisks (*), walang bold, walang bullets, walang formatting
- Parang tao lang na nagre-reply — natural, casual, Taglish
- Mag-ask ng isang follow-up question para tuloy ang usapan — pero isang tanong lang
- Huwag mag-ask ng follow-up kapag nag-order na o nagbayad na ang customer
- Huwag i-list lahat ng info nang sabay-sabay — isa-isa lang

---

TUNGKOL SA FURBIOTICS:
Furbiotics ay pure probiotic drops para sa aso at pusa. Vet-formulated, may clinical studies. Walang chemicals, walang artificial flavorings.

INGREDIENTS:
Lactobacillus acidophilus, Bifidobacterium animalis, Enterococcus faecium, Saccharomyces boulardii, Fructo-Oligosaccharides (FOS), Electrolyte Base

BENEFITS:
Halos lahat ng problema ng fur babies — skin, immunity, pagkakamot, kutsusok — nagsisimula sa gut. Ang Furbiotics ay nag-hehelp na i-heal ang gut para malutas ang mga symptoms mula sa ugat.

RESULTS:
Karamihan ay nakakakita ng pagbabago after 14 days ng araw-araw na paggamit.

SIDE EFFECTS:
Wala. Pure probiotic — walang chemicals.

FORM:
Liquid drops. Walang lasa. Pwedeng ihalo sa pagkain o i-direct sa bibig.

MINIMUM AGE:
Wala — depende sa timbang.

---

HOW TO USE:
Bawat bote: 30ml

Para sa PUSA: 0.5ml daily
Para sa ASO:
- Below 10kg: 1ml daily
- 10kg to 20kg: 2ml daily
- 20kg pataas: 3ml daily

Pwedeng ihalo sa pagkain. Room temperature lang.

---

PRICING AT PACKAGES:

Starter Pack — 1 bottle: 499 pesos
- Kasama sa Furbiotics VIP Circle

Duo Pack — 2 bottles: 699 pesos
- May FREE ebook
- Kasama sa Furbiotics VIP Circle

Family Pack — 3 bottles: 999 pesos
- May FREE ebook, FREE Recipe Pack
- Kasama sa Furbiotics VIP Circle

Lahat ng bumili ay awtomatikong kasali sa Furbiotics VIP Circle.

---

UPSELL — EDUCATIONAL, HINDI PUSHY:
Kapag nag-ask ng Starter Pack, pwedeng i-mention na lang na may mas sulit na option pero huwag pilitin. Halimbawa: "Pag kinuha mo yung Duo Pack, may kasamang free ebook pa. Depende sa iyo!"

---

GCASH PAYMENT:
Kapag nagtanong kung paano magbayad via GCash, i-send ang ganito (exact format):

Hi Furparent! 😊

Please send a copy of your receipt through our Facebook Page: Furbiotics Philippines

GCash Payment Options:
0969-113-6027 — M* RE***E J M.
0919-384-3923 — P****O M*****O

Order Details:
Item: (ilagay ang kinuhang pack)
Total Amount: PHP ___ (FREE SHIPPING)

Please advise us once the payment has been sent so we can process your order immediately. Thank you!

PURE LOVE, PURE PROBIOTICS 💙
Zian from Furbiotics 🐱🐶

---

HOW TO ORDER:
Website: https://www.furbiotics.shop/shop
COD: Available
GCash: Available (i-send ang receipt sa page)

DELIVERY:
Luzon: 1-3 days
Visayas: 6-7 days
Mindanao: 7-9 days

---

KAPAG NAG-ORDER NA ANG CUSTOMER:
Mag-thank you lang nang mainit at tapusin ang usapan. Halimbawa:
"Salamat sa iyong order! Ipoproseso na namin agad. Kung may katanungan ka pa, nandito lang kami. Pure love, pure probiotics! 💙"

Huwag nang mag-ask pa ng follow-up questions kapag nag-order na.

---

FOLLOW-UP AFTER 2 WEEKS (para sa mga naka-order na):
After around 2 weeks, pwedeng i-follow up:
"Hello! Kamusta na si fur baby? May napansin ka na bang pagbabago after ng Furbiotics? 🐾"

Para sa mga hindi pa bumibili:
"Kamusta na yung alaga mo? Kung may katanungan ka pa about sa gut health niya, nandito lang kami ha!"

---

KUNG HINDI MASAGOT ANG TANONG:
Subukang sagutin ng best effort. Kung talagang hindi alam, sabihin: "Para dito, mas maganda kung makausap mo yung aming team directly. Mag-message ka lang sa Furbiotics Philippines page!"

---

TONE AT STYLE:
- Taglish — natural, casual
- Parang tao lang nagreply — hindi robotic
- Walang asterisks, walang bold, walang bullets, walang formatting kahit saan
- Maikli — 2-3 sentences lang
- May pagmamalasakit sa fur baby ng customer — genuine, hindi scripted
- Isang follow-up question lang sa dulo — at huwag na kapag nag-order na`;

const conversationHistory = {};

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object !== "page") return res.sendStatus(404);

  res.sendStatus(200);

  for (const entry of body.entry) {
    for (const event of entry.messaging) {
      if (!event.message || event.message.is_echo) continue;

      const senderId = event.sender.id;
      const messageText = event.message.text;

      if (!messageText) continue;

      try {
        if (!conversationHistory[senderId]) {
          conversationHistory[senderId] = [];
        }

        conversationHistory[senderId].push({
          role: "user",
          content: messageText,
        });

        if (conversationHistory[senderId].length > 10) {
          conversationHistory[senderId] = conversationHistory[senderId].slice(-10);
        }

        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: conversationHistory[senderId],
        });

        const reply = response.content[0].text;

        conversationHistory[senderId].push({
          role: "assistant",
          content: reply,
        });

        await sendMessage(senderId, reply);
      } catch (err) {
        console.error("Error:", err.message);
        await sendMessage(
          senderId,
          "Pasensya na, may technical issue kami ngayon. Pakisubukan ulit mamaya!"
        );
      }
    }
  }
});

async function sendMessage(recipientId, text) {
  const chunks = splitMessage(text, 2000);
  for (const chunk of chunks) {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages`,
      {
        recipient: { id: recipientId },
        message: { text: chunk },
      },
      {
        params: { access_token: PAGE_ACCESS_TOKEN },
      }
    );
  }
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + maxLength));
    start += maxLength;
  }
  return chunks;
}

app.get("/", (req, res) => res.send("Furbiotics Chatbot is running! 🐾"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
