const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const PANCAKE_API_KEY = process.env.PANCAKE_API_KEY;
const PANCAKE_SHOP_ID = process.env.PANCAKE_SHOP_ID;
const PANCAKE_BASE = "https://pos.pages.fm/api/v1";

const PACK_INFO = {
  starter: { custom_id: "SP-499", name: "Starter Pack - FurBiotics", price: 499000 },
  duo:     { custom_id: "DP-699", name: "Duo Pack - Furbiotics",     price: 699000 },
  family:  { custom_id: "FP-999", name: "Family Pack - Furbiotics",  price: 999000 }
};

const conversationHistory = {};
const pendingOrders = {};

// ─── Pancake Helpers ───────────────────────────────────────────────

async function getProductVariation(custom_id) {
  try {
    const res = await axios.get(`${PANCAKE_BASE}/shops/${PANCAKE_SHOP_ID}/products`, {
      params: { api_key: PANCAKE_API_KEY, custom_id }
    });
    const products = res.data?.data || res.data?.products || [];
    const product = Array.isArray(products) ? products.find(p => p.custom_id === custom_id) : null;
    if (!product) return null;
    const variation = product.variations?.[0];
    return { product_id: product.id, variation_id: variation?.id };
  } catch (e) {
    console.error("getProductVariation error:", e.message);
    return null;
  }
}

async function searchAddress(query) {
  try {
    // Try Pancake address search endpoint
    const res = await axios.get(`${PANCAKE_BASE}/shipping_addresses/search`, {
      params: { api_key: PANCAKE_API_KEY, q: query }
    });
    return res.data?.data || [];
  } catch (e) {
    console.error("searchAddress error:", e.message);
    return [];
  }
}

async function resolveAddress(rawAddress) {
  // Parse the raw address string into parts
  // Expected format: "street, barangay, municipality/city, province"
  const parts = rawAddress.split(",").map(p => p.trim());

  let street = "", commune = "", district = "", province = "";

  if (parts.length >= 4) {
    street = parts.slice(0, parts.length - 3).join(", ");
    commune = parts[parts.length - 3];
    district = parts[parts.length - 2];
    province = parts[parts.length - 1];
  } else if (parts.length === 3) {
    commune = parts[0];
    district = parts[1];
    province = parts[2];
  } else if (parts.length === 2) {
    district = parts[0];
    province = parts[1];
  } else {
    province = parts[0];
  }

  // Search Pancake for matching commune
  const searchQuery = [commune, district, province].filter(Boolean).join(" ");
  const results = await searchAddress(searchQuery);

  let province_id = null, district_id = null, commune_id = null;
  let matched_province = province, matched_district = district, matched_commune = commune;

  if (results.length > 0) {
    const match = results[0];
    province_id = match.province_id || match.province?.id;
    district_id = match.district_id || match.district?.id;
    commune_id = match.commune_id || match.id;
    matched_province = match.province_name || match.province?.name || province;
    matched_district = match.district_name || match.district?.name || district;
    matched_commune = match.commune_name || match.name || commune;
  }

  return {
    street,
    commune, district, province,
    commune_id, district_id, province_id,
    matched_commune, matched_district, matched_province,
    full_address: [street, matched_commune, matched_district, matched_province].filter(Boolean).join(", ")
  };
}

async function createPancakeOrder(orderData) {
  try {
    const { name, phone, address, pack, payment } = orderData;

    const packKey = pack.toLowerCase().includes("family") ? "family"
                  : pack.toLowerCase().includes("duo")    ? "duo"
                  : "starter";

    const packInfo = PACK_INFO[packKey];

    // Get product + variation IDs
    const variation = await getProductVariation(packInfo.custom_id);

    // Resolve address to Pancake IDs
    const addr = await resolveAddress(address);

    const payload = {
      order: {
        bill_full_name: name,
        bill_phone_number: phone.replace(/\D/g, "").replace(/^0/, "63"),
        note: `Order via Furbiotics Messenger Bot. Payment: ${payment}`,
        shipping_address: {
          full_name: name,
          phone_number: phone.replace(/\D/g, "").replace(/^0/, "63"),
          address: addr.street || addr.commune,
          commune_id: addr.commune_id,
          district_id: addr.district_id,
          province_id: addr.province_id,
          commune_name: addr.matched_commune,
          district_name: addr.matched_district,
          province_name: addr.matched_province,
          full_address: addr.full_address,
          country_code: "63"
        },
        payment_type: payment.toLowerCase().includes("gcash") ? "bank_transfer" : "cod",
        items: [
          variation
            ? {
                product_id: variation.product_id,
                variation_id: variation.variation_id,
                quantity: 1,
                price: packInfo.price
              }
            : {
                name: packInfo.name,
                quantity: 1,
                price: packInfo.price
              }
        ]
      }
    };

    const res = await axios.post(
      `${PANCAKE_BASE}/shops/${PANCAKE_SHOP_ID}/orders`,
      payload,
      { params: { api_key: PANCAKE_API_KEY } }
    );

    return res.data;
  } catch (e) {
    console.error("createPancakeOrder error:", e.message, e.response?.data);
    return null;
  }
}

// ─── Parse Order Signal ────────────────────────────────────────────

function parseOrderSignal(text) {
  const match = text.match(/\[PROCESS_ORDER:([^\]]+)\]/);
  if (!match) return null;
  const raw = match[1];
  const obj = {};
  raw.split("|").forEach(part => {
    const [k, ...v] = part.split("=");
    if (k) obj[k.trim()] = v.join("=").trim();
  });
  return obj;
}

// ─── System Prompt ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `Ikaw ang friendly assistant ng Furbiotics Philippines. Ang trabaho mo ay tulungan ang mga fur parents at gawing customer sila nang natural — hindi forced, hindi salesy.

---

PINAKAMAHALAGANG RULES SA PAGSAGOT:
- 1 to 3 sentences lang ang sagot — maikli, natural, parang tao
- Walang asterisks, walang bold, walang bullets, walang formatting
- Pwede mag-emoji pero huwag lagi — smile lang minsan, natural
- Taglish — casual, friendly, parang kaibigan lang
- Huwag mag-list ng maraming info nang sabay-sabay — isa-isa lang
- Mukhang tao ang dating, hindi bot

---

BUYING SIGNALS — KAPAG NARAMDAMAN MONG BIBILI NA:
- "HM", "hm", "h.m.", "how much", "magkano", "pila", "presyo"
- "paano mag-order", "pwede mag-order", "gusto ko sana", "pano bumili", "order na"
- "kumuha na", "bilhin ko", "try ko", "i-try ko"
- Nagtanong ng delivery, shipping, o kung saan pwede bumili
- "para sa aso ko", "para sa pusa ko" na may tono ng gustong bilhin

KAPAG NAKITA MO ANG BUYING SIGNAL — GAWIN ITO AGAD:
Huwag nang mag-explain pa ng product. Tanungin na agad ang order details — isa-isa lang.

Una, tanungin:
"Sige! Para maprocess na natin, pwede mo bang ibigay yung complete name mo, contact number, at complete address (barangay, bayan/lungsod, probinsya)?"

Kapag nagbigay na ng info, tanungin ang pack at payment:
"Anong package gusto mo? Starter Pack (1 bote - 499 pesos), Duo Pack (2 bote - 699 pesos), o Family Pack (3 bote - 999 pesos)? At GCash o COD?"

KAPAG GCASH ANG PINILI — I-SEND ANG EXACT NA ITO:

Hi! 😊

Please send a copy of your receipt through our Facebook Page: Furbiotics Philippines

GCash Payment Options:
0969-113-6027 — M* RE***E J M.
0919-384-3923 — P****O M*****O

Order Details:
Item: [pack na pinili]
Total Amount: PHP [amount] (FREE SHIPPING)

Please advise us once the payment has been sent so we can process your order immediately. Thank you!

Pure love, pure probiotics
Zian from Furbiotics

KAPAG COD ANG PINILI:
"Para sa COD, mag-order ka na lang dito: furbiotics.shop/shop — doon mo mako-confirm yung order mo!"

KAPAG KUMPLETO NA ANG LAHAT (name, phone, address, pack, payment) — GAWIN ITO:
1. I-summarize sa customer: "Okay, nakuha ko na! [name], [address], [phone], [pack]. May tatawag sa iyo ang aming team para i-confirm. Salamat!"
2. Sa DULO ng iyong reply, palaging idagdag ang signal na ito (huwag ipakita sa customer — system tag ito):
[PROCESS_ORDER: name=[name]|phone=[phone]|address=[address]|pack=[starter o duo o family]|payment=[gcash o cod]]

---

PRICING AT PACKAGES:
Starter Pack — 1 bote: 499 pesos (kasali sa Furbiotics VIP Circle)
Duo Pack — 2 bote: 699 pesos (may FREE ebook, kasali sa VIP Circle)
Family Pack — 3 bote: 999 pesos (may FREE ebook, Recipe Pack, Loyalty card, kasali sa VIP Circle)
Lahat may FREE SHIPPING.

---

TUNGKOL SA FURBIOTICS:
Pure probiotic drops para sa aso at pusa. Vet-formulated, may clinical studies. Walang chemicals, walang artificial flavorings. Liquid drops — walang lasa, pwedeng ihalo sa pagkain o i-direct sa bibig.

BENEFITS:
Halos lahat ng problema ng fur babies — skin issues, low immunity, pagkakamot, kutsusok — nagsisimula sa gut. Ang Furbiotics ay nag-hehelp na i-heal ang gut para malutas ang mga symptoms mula sa ugat.

RESULTS: Karaniwang nakikita ang pagbabago after 14 days.
SIDE EFFECTS: Wala. Pure probiotic.

HOW TO USE:
Bawat bote: 30ml
Pusa: 0.5ml daily
Aso below 10kg: 1ml daily
Aso 10kg-20kg: 2ml daily
Aso 20kg pataas: 3ml daily

---

KAPAG MAY CONCERN O PROBLEMA ANG ALAGA:
Tulungan muna sila — huwag agad ibenta. Magtanong ng may pagmamalasakit:
"Kamusta na yung alaga mo? Anong mga symptoms ang nakikita mo?"

Pakinggan muna. Kapag naipaliwanag na, i-introduce ang Furbiotics nang natural:
"Kadalasan, yung ganyang symptoms ay nagsisimula sa gut. May natuklasan kaming paraan para tulungan ang fur babies na may ganitong concern..."

Pagkatapos ma-introduce — kapag interesado na — balik sa buying signal approach.

---

DELIVERY:
Luzon: 1-3 days
Visayas: 6-7 days
Mindanao: 7-9 days
Lahat may FREE SHIPPING.

---

KAPAG NAG-ORDER NA:
Mag-thank you nang mainit at tapusin ang usapan.

---

FOLLOW-UP AFTER 2 WEEKS:
"Hello! Kamusta na si fur baby? May napansin ka na bang pagbabago after ng Furbiotics?"

Para sa hindi pa bumibili:
"Kamusta na yung alaga mo? Kung may katanungan ka pa, nandito lang kami ha."

---

KUNG HINDI MASAGOT:
"Para dito, mas maganda kung makausap mo yung aming team directly. Mag-message ka lang dito sa page!"

---

TONE AT STYLE:
- Taglish — natural, casual
- Parang tao lang nagreply — hindi robotic
- Walang asterisks, walang bold, walang bullets, walang formatting
- 1 to 3 sentences lang
- May pagmamalasakit sa fur baby — genuine
- Pwede mag-smile emoji minsan pero huwag lagi
- Isang follow-up question lang sa dulo kapag kailangan — huwag na kapag nag-order na`;

// ─── Webhook ───────────────────────────────────────────────────────

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
        if (!conversationHistory[senderId]) conversationHistory[senderId] = [];

        conversationHistory[senderId].push({ role: "user", content: messageText });
        if (conversationHistory[senderId].length > 20) {
          conversationHistory[senderId] = conversationHistory[senderId].slice(-20);
        }

        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: conversationHistory[senderId],
        });

        let reply = response.content[0].text;

        // Check for order signal
        const orderData = parseOrderSignal(reply);
        if (orderData && orderData.name && orderData.phone && orderData.address) {
          console.log("Creating Pancake order:", orderData);
          const result = await createPancakeOrder(orderData);
          if (result?.success || result?.data) {
            console.log("Order created successfully:", result?.data?.id || result);
          } else {
            console.error("Order creation failed:", result);
          }
          // Remove the signal tag from the message sent to customer
          reply = reply.replace(/\[PROCESS_ORDER:[^\]]+\]/g, "").trim();
        }

        conversationHistory[senderId].push({ role: "assistant", content: reply });
        await sendMessage(senderId, reply);

      } catch (err) {
        console.error("Error:", err.message);
        await sendMessage(senderId, "Pasensya na, may technical issue kami ngayon. Pakisubukan ulit mamaya!");
      }
    }
  }
});

async function sendMessage(recipientId, text) {
  const chunks = splitMessage(text, 2000);
  for (const chunk of chunks) {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages`,
      { recipient: { id: recipientId }, message: { text: chunk } },
      { params: { access_token: PAGE_ACCESS_TOKEN } }
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

app.get("/", (req, res) => res.send("Furbiotics Chatbot is running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
