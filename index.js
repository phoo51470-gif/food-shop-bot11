const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");

const BOT_TOKEN = process.env.BOT_TOKEN;

const ADMIN_IDS = [
  7215773501,
  8280688161
];

const BACKUP_CHANNEL_ID = "3981678066";

const DATABASE_URL = process.env.DATABASE_URL;

const PORT = process.env.PORT || 10000;

const WEBHOOK_URL = process.env.WEBHOOK_URL;

const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET || "food_shop_secret_2026";

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const app = express();

app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const userStates = new Map();
const userInfo = new Map();

function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

function money(value) {
  return Number(value).toLocaleString();
}

function escapeText(text) {
  if (!text) return "";

  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function saveUserInfo(msg) {
  if (!msg.from) return;

  userInfo.set(Number(msg.from.id), {
    username: msg.from.username || null,
    firstName: msg.from.first_name || null
  });
}

function getUserInfo(userId) {
  return (
    userInfo.get(Number(userId)) || {
      username: null,
      firstName: null
    }
  );
}

function customerKeyboard() {
  return {
    keyboard: [
      ["🍴 Menu", "🛒 Cart"],
      ["📦 My Orders"]
    ],
    resize_keyboard: true
  };
}

function adminKeyboard() {
  return {
    keyboard: [
      ["➕ Add Menu", "🍴 Menu List"],
      ["✏️ Edit Menu", "🗑 Delete Menu"],
      ["📦 Orders", "📊 Order History"]
    ],
    resize_keyboard: true
  };
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC NOT NULL,
      description TEXT,
      photo_file_id TEXT,
      backup_message_id BIGINT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS carts (
      user_id BIGINT NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, product_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_number INTEGER UNIQUE NOT NULL,
      user_id BIGINT NOT NULL,
      username TEXT,
      first_name TEXT,
      phone TEXT,
      address TEXT,
      total NUMERIC NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      price NUMERIC NOT NULL,
      quantity INTEGER NOT NULL
    )
  `);

  console.log("Database initialized");
}

bot.onText(/^\/start$/, async (msg) => {
  const userId = msg.from.id;

  saveUserInfo(msg);
  userStates.delete(userId);

  if (isAdmin(userId)) {
    await bot.sendMessage(
      userId,
      "👑 Admin Panel\n\nမင်္ဂလာပါ Admin။",
      {
        reply_markup: adminKeyboard()
      }
    );
  } else {
    await bot.sendMessage(
      userId,
      "🍽️ Food Shop မှ ကြိုဆိုပါတယ်။",
      {
        reply_markup: customerKeyboard()
      }
    );
  }
});

bot.on("message", async (msg) => {
  try {
    if (!msg.from) return;

    saveUserInfo(msg);

    const userId = msg.from.id;
    const text = msg.text || "";

    if (text.startsWith("/")) return;

    if (isAdmin(userId)) {
      await handleAdminMessage(msg);
    } else {
      await handleCustomerMessage(msg);
    }
  } catch (error) {
    console.error("Message error:", error);
  }
});

async function handleAdminMessage(msg) {
  const userId = msg.from.id;
  const text = msg.text || "";
  const state = userStates.get(userId);

  if (
    state &&
    state.type === "add_menu" &&
    msg.photo &&
    msg.caption
  ) {
    await addMenuFromPhoto(msg);
    return;
  }

  if (
    state &&
    state.type === "edit_photo" &&
    msg.photo
  ) {
    await editMenuPhoto(msg);
    return;
  }

  if (text === "➕ Add Menu") {
    userStates.set(userId, {
      type: "add_menu"
    });

    await bot.sendMessage(
      userId,
      "➕ Add Menu\n\n" +
      "Photo တစ်ပုံပို့ပြီး Caption ထဲမှာ ဒီလိုရေးပါ👇\n\n" +
      "အစားအသောက်နာမည် | စျေး | Description\n\n" +
      "ဥပမာ:\n" +
      "ကြက်သားထမင်း | 5000 | ကြက်သား၊ ထမင်း၊ ဟင်းသီးဟင်းရွက် ပါဝင်သည်\n\n" +
      "Description မလိုရင်:\n" +
      "ကြက်သားထမင်း | 5000"
    );

    return;
  }

  if (text === "🍴 Menu List") {
    await showAdminMenuList(userId);
    return;
  }

  if (text === "✏️ Edit Menu") {
    await showEditMenuList(userId);
    return;
  }

  if (text === "🗑 Delete Menu") {
    await showDeleteMenuList(userId);
    return;
  }

  if (text === "📦 Orders") {
    await showActiveOrders(userId);
    return;
  }

  if (text === "📊 Order History") {
    await showOrderHistory(userId);
    return;
  }

  if (state && state.type === "edit_name") {
    await updateProductName(
      userId,
      state.productId,
      text
    );
    return;
  }

  if (state && state.type === "edit_price") {
    await updateProductPrice(
      userId,
      state.productId,
      text
    );
    return;
  }

  if (state && state.type === "edit_description") {
    await updateProductDescription(
      userId,
      state.productId,
      text
    );
  }
}

async function handleCustomerMessage(msg) {
  const userId = msg.from.id;
  const text = msg.text || "";
  const state = userStates.get(userId);

  if (state && state.type === "checkout_phone") {
    await handleCheckoutPhone(userId, text);
    return;
  }

  if (state && state.type === "checkout_address") {
    await handleCheckoutAddress(userId, text);
    return;
  }

  if (text === "🍴 Menu") {
    await showCustomerMenu(userId);
    return;
  }

  if (text === "🛒 Cart") {
    await showCart(userId);
    return;
  }

  if (text === "📦 My Orders") {
    await showCustomerOrders(userId);
  }
}

async function addMenuFromPhoto(msg) {
  const userId = msg.from.id;

  try {
    const photo =
      msg.photo[msg.photo.length - 1];

    const caption =
      msg.caption.trim();

    const parts =
      caption.split("|");

    const name =
      parts[0]
        ? parts[0].trim()
        : "";

    const priceText =
      parts[1]
        ? parts[1].trim()
        : "";

    const description =
      parts[2]
        ? parts.slice(2).join("|").trim()
        : "";

    if (!name || !priceText) {
      await bot.sendMessage(
        userId,
        "❌ Format မမှန်ပါ။\n\nဥပမာ:\nကြက်သားထမင်း | 5000 | Description"
      );

      return;
    }

    const price =
      Number(
        priceText.replace(/,/g, "")
      );

    if (!Number.isFinite(price) || price <= 0) {
      await bot.sendMessage(
        userId,
        "❌ စျေးနှုန်းမှန်ကန်စွာထည့်ပါ။"
      );

      return;
    }

    const result =
      await pool.query(
        `
        INSERT INTO products
        (name, price, description, photo_file_id)
        VALUES ($1,$2,$3,$4)
        RETURNING id
        `,
        [
          name,
          price,
          description,
          photo.file_id
        ]
      );

    const productId =
      result.rows[0].id;

    try {
      const backup =
        await bot.sendPhoto(
          BACKUP_CHANNEL_ID,
          photo.file_id,
          {
            caption:
              `🍽️ ${name}\n\n` +
              `💰 ${money(price)}\n\n` +
              `${description || ""}`
          }
        );

      await pool.query(
        `
        UPDATE products
        SET backup_message_id = $1
        WHERE id = $2
        `,
        [
          backup.message_id,
          productId
        ]
      );
    } catch (error) {
      console.error(
        "Backup error:",
        error.message
      );
    }

    userStates.delete(userId);

    await bot.sendMessage(
      userId,
      "✅ Menu ထည့်ပြီးပါပြီ။\n\n" +
      `🍽️ ${name}\n` +
      `💰 ${money(price)}\n` +
      `📝 ${description || "မရှိ"}`,
      {
        reply_markup: adminKeyboard()
      }
    );
  } catch (error) {
    console.error(
      "Add menu error:",
      error
    );

    await bot.sendMessage(
      userId,
      "❌ Menu ထည့်ရာမှာ Error ဖြစ်သွားပါတယ်။"
    );
  }
}

async function showCustomerMenu(userId) {
  const result =
    await pool.query(
      `
      SELECT *
      FROM products
      ORDER BY id ASC
      `
    );

  if (!result.rows.length) {
    await bot.sendMessage(
      userId,
      "🍽️ Menu မရှိသေးပါ။"
    );

    return;
  }

  for (const product of result.rows) {
    await bot.sendPhoto(
      userId,
      product.photo_file_id,
      {
        caption:
          `🍽️ ${product.name}\n\n` +
          `💰 ${money(product.price)}\n\n` +
          `${product.description || ""}`,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "➕ Add to Cart",
                callback_data:
                  `add_${product.id}`
              }
            ]
          ]
        }
      }
    );
  }
}

bot.on(
  "callback_query",
  async (query) => {
    try {
      const userId =
        query.from.id;

      const data =
        query.data;

      saveUserInfo({
        from: query.from
      });

      if (data.startsWith("add_")) {
        const productId =
          Number(
            data.replace("add_", "")
          );

        await addToCart(
          userId,
          productId
        );

        await bot.answerCallbackQuery(
          query.id,
          {
            text:
              "🛒 Cart ထဲထည့်ပြီးပါပြီ။"
          }
        );

        return;
      }

      if (data.startsWith("plus_")) {
        const productId =
          Number(
            data.replace("plus_", "")
          );

        await changeCartQuantity(
          userId,
          productId,
          1
        );

        await bot.answerCallbackQuery(
          query.id
        );

        await showCart(userId);

        return;
      }

      if (data.startsWith("minus_")) {
        const productId =
          Number(
            data.replace("minus_", "")
          );

        await changeCartQuantity(
          userId,
          productId,
          -1
        );

        await bot.answerCallbackQuery(
          query.id
        );

        await showCart(userId);

        return;
      }

      if (data === "checkout") {
        await startCheckout(userId);

        await bot.answerCallbackQuery(
          query.id
        );

        return;
      }

      if (data === "cancel_checkout") {
        userStates.delete(userId);

        await bot.answerCallbackQuery(
          query.id
        );

        await bot.sendMessage(
          userId,
          "❌ Checkout ဖျက်လိုက်ပါပြီ။",
          {
            reply_markup:
              customerKeyboard()
          }
        );

        return;
      }

      if (data === "confirm_order") {
        await createOrder(userId);

        await bot.answerCallbackQuery(
          query.id
        );

        return;
      }

      if (data.startsWith("accept_")) {
        if (!isAdmin(userId)) return;

        const orderId =
          Number(
            data.replace("accept_", "")
          );

        await updateOrderStatus(
          orderId,
          "accepted"
        );

        await bot.answerCallbackQuery(
          query.id,
          {
            text: "Order Accepted"
          }
        );

        return;
      }

      if (data.startsWith("preparing_")) {
        if (!isAdmin(userId)) return;

        const orderId =
          Number(
            data.replace("preparing_", "")
          );

        await updateOrderStatus(
          orderId,
          "preparing"
        );

        await bot.answerCallbackQuery(
          query.id
        );

        return;
      }

      if (data.startsWith("delivering_")) {
        if (!isAdmin(userId)) return;

        const orderId =
          Number(
            data.replace("delivering_", "")
          );

        await updateOrderStatus(
          orderId,
          "delivering"
        );

        await bot.answerCallbackQuery(
          query.id
        );

        return;
      }

      if (data.startsWith("delivered_")) {
        if (!isAdmin(userId)) return;

        const orderId =
          Number(
            data.replace("delivered_", "")
          );

        await updateOrderStatus(
          orderId,
          "delivered"
        );

        await bot.answerCallbackQuery(
          query.id
        );

        return;
      }

      if (data.startsWith("cancel_")) {
        if (!isAdmin(userId)) return;

        const orderId =
          Number(
            data.replace("cancel_", "")
          );

        await updateOrderStatus(
          orderId,
          "cancelled"
        );

        await bot.answerCallbackQuery(
          query.id
        );

        return;
      }

      if (data.startsWith("editproduct_")) {
        if (!isAdmin(userId)) return;

        const productId =
          Number(
            data.replace(
              "editproduct_",
              ""
            )
          );

        await showEditOptions(
          userId,
          productId
        );

        await bot.answerCallbackQuery(
          query.id
        );

        return;
      }

      if (data.startsWith("editname_")) {
        if (!isAdmin(userId)) return;

        const productId =
          Number(
            data.replace(
              "editname_",
              ""
            )
          );

        userStates.set(
          userId,
          {
            type: "edit_name",
            productId
          }
        );

        await bot.answerCallbackQuery(
          query.id
        );

        await bot.sendMessage(
          userId,
          "✏️ Menu နာမည်အသစ် ပို့ပါ။"
        );

        return;
      }

      if (data.startsWith("editprice_")) {
        if (!isAdmin(userId)) return;

        const productId =
          Number(
            data.replace(
              "editprice_",
              ""
            )
          );

        userStates.set(
          userId,
          {
            type: "edit_price",
            productId
          }
        );

        await bot.answerCallbackQuery(
          query.id
        );

        await bot.sendMessage(
          userId,
          "💰 စျေးအသစ် ပို့ပါ။"
        );

        return;
      }

      if (data.startsWith("editdesc_")) {
        if (!isAdmin(userId)) return;

        const productId =
          Number(
            data.replace(
              "editdesc_",
              ""
            )
          );

        userStates.set(
          userId,
          {
            type: "edit_description",
            productId
          }
        );

        await bot.answerCallbackQuery(
          query.id
        );

        await bot.sendMessage(
          userId,
          "📝 Description အသစ် ပို့ပါ။"
        );

        return;
      }

      if (data.startsWith("editphoto_")) {
        if (!isAdmin(userId)) return;

        const productId =
          Number(
            data.replace(
              "editphoto_",
              ""
            )
          );

        userStates.set(
          userId,
          {
            type: "edit_photo",
            productId
          }
        );

        await bot.answerCallbackQuery(
          query.id
        );

        await bot.sendMessage(
          userId,
          "📸 Photo အသစ် ပို့ပါ။"
        );

        return;
      }

      if (data.startsWith("deleteproduct_")) {
        if (!isAdmin(userId)) return;

        const productId =
          Number(
            data.replace(
              "deleteproduct_",
              ""
            )
          );

        await deleteProduct(
          userId,
          productId
        );

        await bot.answerCallbackQuery(
          query.id
        );
      }
    } catch (error) {
      console.error(
        "Callback error:",
        error
      );
    }
  }
);

async function addToCart(
  userId,
  productId
) {
  await pool.query(
    `
    INSERT INTO carts
    (user_id, product_id, quantity)
    VALUES ($1,$2,1)
    ON CONFLICT
    (user_id, product_id)
    DO UPDATE SET
    quantity =
      carts.quantity + 1
    `,
    [
      userId,
      productId
    ]
  );
}

async function changeCartQuantity(
  userId,
  productId,
  amount
) {
  const result =
    await pool.query(
      `
      SELECT quantity
      FROM carts
      WHERE user_id = $1
      AND product_id = $2
      `,
      [
        userId,
        productId
      ]
    );

  if (!result.rows.length) {
    return;
  }

  const quantity =
    Number(
      result.rows[0].quantity
    ) + amount;

  if (quantity <= 0) {
    await pool.query(
      `
      DELETE FROM carts
      WHERE user_id = $1
      AND product_id = $2
      `,
      [
        userId,
        productId
      ]
    );

    return;
  }

  await pool.query(
    `
    UPDATE carts
    SET quantity = $1
    WHERE user_id = $2
    AND product_id = $3
    `,
    [
      quantity,
      userId,
      productId
    ]
  );
}

async function getCart(userId) {
  const result =
    await pool.query(
      `
      SELECT
        carts.product_id,
        carts.quantity,
        products.name,
        products.price,
        products.photo_file_id
      FROM carts
      JOIN products
        ON products.id =
           carts.product_id
      WHERE carts.user_id = $1
      ORDER BY products.id
      `,
      [userId]
    );

  let total = 0;

  const items =
    result.rows.map(
      (item) => {
        const itemTotal =
          Number(item.price) *
          Number(item.quantity);

        total += itemTotal;

        return {
          productId:
            item.product_id,
          name:
            item.name,
          price:
            Number(item.price),
          quantity:
            Number(item.quantity),
          total:
            itemTotal
        };
      }
    );

  return {
    items,
    total
  };
}

async function showCart(userId) {
  const cart =
    await getCart(userId);

  if (!cart.items.length) {
    await bot.sendMessage(
      userId,
      "🛒 Cart ထဲမှာ ဘာမှမရှိသေးပါ။"
    );

    return;
  }

  let message =
    "🛒 <b>Your Cart</b>\n\n";

  for (const item of cart.items) {
    message +=
      `🍽️ ${escapeText(item.name)}\n` +
      `   ${item.quantity} × ${money(item.price)} = ${money(item.total)}\n\n`;
  }

  message +=
    `💰 <b>Total: ${money(cart.total)}</b>`;

  const buttons =
    cart.items.map(
      (item) => [
        {
          text: `➖ ${item.name}`,
          callback_data:
            `minus_${item.productId}`
        },
        {
          text: `Qty ${item.quantity}`,
          callback_data:
            `noop_${item.productId}`
        },
        {
          text: "➕",
          callback_data:
            `plus_${item.productId}`
        }
      ]
    );

  buttons.push([
    {
      text: "✅ Checkout",
      callback_data:
        "checkout"
    }
  ]);

  await bot.sendMessage(
    userId,
    message,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard:
          buttons
      }
    }
  );
}

async function startCheckout(userId) {
  const cart =
    await getCart(userId);

  if (!cart.items.length) {
    await bot.sendMessage(
      userId,
      "🛒 Cart empty ဖြစ်နေပါတယ်။"
    );

    return;
  }

  userStates.set(
    userId,
    {
      type:
        "checkout_phone"
    }
  );

  await bot.sendMessage(
    userId,
    "📱 ဖုန်းနံပါတ် ပို့ပါ။\n\nဥပမာ - 09xxxxxxxxx"
  );
}

async function handleCheckoutPhone(
  userId,
  phone
) {
  if (!phone || phone.length < 5) {
    await bot.sendMessage(
      userId,
      "❌ ဖုန်းနံပါတ် မှန်ကန်စွာထည့်ပါ။"
    );

    return;
  }

  userStates.set(
    userId,
    {
      type:
        "checkout_address",
      phone
    }
  );

  await bot.sendMessage(
    userId,
    "📍 ပို့ဆောင်ရမည့် လိပ်စာ ပို့ပါ။"
  );
}

async function handleCheckoutAddress(
  userId,
  address
) {
  const state =
    userStates.get(userId);

  if (!address) {
    return;
  }

  const cart =
    await getCart(userId);

  if (!cart.items.length) {
    userStates.delete(userId);

    await bot.sendMessage(
      userId,
      "🛒 Cart empty ဖြစ်နေပါတယ်။"
    );

    return;
  }

  userStates.set(
    userId,
    {
      type:
        "checkout_confirm",
      phone:
        state.phone,
      address
    }
  );

  let message =
    "🧾 <b>Order Confirmation</b>\n\n";

  for (const item of cart.items) {
    message +=
      `🍽️ ${escapeText(item.name)}\n` +
      `   ${item.quantity} × ${money(item.price)} = ${money(item.total)}\n\n`;
  }

  message +=
    `💰 <b>Total: ${money(cart.total)}</b>\n\n` +
    `📱 Phone: ${escapeText(state.phone)}\n` +
    `📍 Address: ${escapeText(address)}`;

  await bot.sendMessage(
    userId,
    message,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                "✅ Confirm Order",
              callback_data:
                "confirm_order"
            }
          ],
          [
            {
              text:
                "❌ Cancel",
              callback_data:
                "cancel_checkout"
            }
          ]
        ]
      }
    }
  );
}

async function createOrder(userId) {
  const state =
    userStates.get(userId);

  if (
    !state ||
    state.type !==
      "checkout_confirm"
  ) {
    return;
  }

  const cart =
    await getCart(userId);

  if (!cart.items.length) {
    return;
  }

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const numberResult =
      await client.query(
        `
        SELECT COALESCE(
          MAX(order_number),
          0
        ) + 1 AS next_number
        FROM orders
        `
      );

    const orderNumber =
      Number(
        numberResult.rows[0]
          .next_number
      );

    const info =
      getUserInfo(userId);

    const orderResult =
      await client.query(
        `
        INSERT INTO orders
        (
          order_number,
          user_id,
          username,
          first_name,
          phone,
          address,
          total,
          status
        )
        VALUES
        ($1,$2,$3,$4,$5,$6,$7,'pending')
        RETURNING id
        `,
        [
          orderNumber,
          userId,
          info.username,
          info.firstName,
          state.phone,
          state.address,
          cart.total
        ]
      );

    const orderId =
      orderResult.rows[0].id;

    for (const item of cart.items) {
      await client.query(
        `
        INSERT INTO order_items
        (
          order_id,
          product_id,
          product_name,
          price,
          quantity
        )
        VALUES
        ($1,$2,$3,$4,$5)
        `,
        [
          orderId,
          item.productId,
          item.name,
          item.price,
          item.quantity
        ]
      );
    }

    await client.query(
      `
      DELETE FROM carts
      WHERE user_id = $1
      `,
      [userId]
    );

    await client.query(
      "COMMIT"
    );

    userStates.delete(userId);

    await bot.sendMessage(
      userId,
      `✅ Order တင်ပြီးပါပြီ။\n\n` +
      `🧾 Order: #${String(orderNumber).padStart(4, "0")}\n` +
      `💰 Total: ${money(cart.total)}\n\n` +
      `⏳ Admin မှ အတည်ပြုရန် စောင့်နေပါသည်။`,
      {
        reply_markup:
          customerKeyboard()
      }
    );

    await sendOrderToAdmins(
      orderId
    );
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    console.error(
      "Create order error:",
      error
    );
  } finally {
    client.release();
  }
}

async function sendOrderToAdmins(
  orderId
) {
  const orderResult =
    await pool.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      `,
      [orderId]
    );

  if (!orderResult.rows.length) {
    return;
  }

  const order =
    orderResult.rows[0];

  const itemsResult =
    await pool.query(
      `
      SELECT *
      FROM order_items
      WHERE order_id = $1
      ORDER BY id
      `,
      [orderId]
    );

  let message =
    `🆕 <b>NEW ORDER</b>\n\n` +
    `🧾 Order: #${String(order.order_number).padStart(4, "0")}\n\n`;

  for (
    const item
    of itemsResult.rows
  ) {
    message +=
      `🍽️ ${escapeText(item.product_name)}\n` +
      `   ${item.quantity} × ${money(item.price)}\n\n`;
  }

  message +=
    `💰 <b>Total: ${money(order.total)}</b>\n\n` +
    `👤 Name: ${escapeText(order.first_name || "-")}\n` +
    `🔹 Username: @${escapeText(order.username || "-")}\n` +
    `🆔 User ID: ${order.user_id}\n` +
    `📱 Phone: ${escapeText(order.phone)}\n` +
    `📍 Address: ${escapeText(order.address)}`;

  for (
    const adminId
    of ADMIN_IDS
  ) {
    try {
      await bot.sendMessage(
        adminId,
        message,
        {
          parse_mode:
            "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    "✅ Accept",
                  callback_data:
                    `accept_${orderId}`
                },
                {
                  text:
                    "❌ Cancel",
                  callback_data:
                    `cancel_${orderId}`
                }
              ]
            ]
          }
        }
      );
    } catch (error) {
      console.error(
        "Admin notification error:",
        error.message
      );
    }
  }
}

async function updateOrderStatus(
  orderId,
  status
) {
  const result =
    await pool.query(
      `
      UPDATE orders
      SET status = $1
      WHERE id = $2
      RETURNING *
      `,
      [
        status,
        orderId
      ]
    );

  if (!result.rows.length) {
    return;
  }

  const order =
    result.rows[0];

  let statusText = "";

  if (status === "accepted") {
    statusText =
      "✅ Order ကို Admin က လက်ခံလိုက်ပါပြီ။";
  }

  if (status === "preparing") {
    statusText =
      "👨‍🍳 Order ကို ပြင်ဆင်နေပါပြီ။";
  }

  if (status === "delivering") {
    statusText =
      "🛵 Order ကို ပို့ဆောင်နေပါပြီ။";
  }

  if (status === "delivered") {
    statusText =
      "🎉 Order ပို့ဆောင်ပြီးပါပြီ။";
  }

  if (status === "cancelled") {
    statusText =
      "❌ Order ကို Cancel လုပ်လိုက်ပါပြီ။";
  }

  try {
    await bot.sendMessage(
      order.user_id,
      `🧾 Order #${String(order.order_number).padStart(4, "0")}\n\n${statusText}`
    );
  } catch (error) {
    console.error(
      "Customer notification error:",
      error.message
    );
  }

  for (
    const adminId
    of ADMIN_IDS
  ) {
    try {
      let keyboard = [];

      if (status === "accepted") {
        keyboard = [
          [
            {
              text:
                "👨‍🍳 Preparing",
              callback_data:
                `preparing_${orderId}`
            },
            {
              text:
                "❌ Cancel",
              callback_data:
                `cancel_${orderId}`
            }
          ]
        ];
      }

      if (status === "preparing") {
        keyboard = [
          [
            {
              text:
                "🛵 Delivering",
              callback_data:
                `delivering_${orderId}`
            }
          ]
        ];
      }

      if (status === "delivering") {
        keyboard = [
          [
            {
              text:
                "🎉 Delivered",
              callback_data:
                `delivered_${orderId}`
            }
          ]
        ];
      }

      if (keyboard.length) {
        await bot.sendMessage(
          adminId,
          `🧾 Order #${String(order.order_number).padStart(4, "0")}\n\nStatus: ${status}`,
          {
            reply_markup: {
              inline_keyboard:
                keyboard
            }
          }
        );
      }
    } catch {}
  }
}

async function showCustomerOrders(
  userId
) {
  const result =
    await pool.query(
      `
      SELECT *
      FROM orders
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 20
      `,
      [userId]
    );

  if (!result.rows.length) {
    await bot.sendMessage(
      userId,
      "📦 Order History မရှိသေးပါ။"
    );

    return;
  }

  let message =
    "📦 My Orders\n\n";

  for (
    const order
    of result.rows
  ) {
    message +=
      `🧾 #${String(order.order_number).padStart(4, "0")}\n` +
      `💰 ${money(order.total)}\n` +
      `📌 ${order.status}\n\n`;
  }

  await bot.sendMessage(
    userId,
    message
  );
}

async function showAdminMenuList(
  userId
) {
  const result =
    await pool.query(
      `
      SELECT *
      FROM products
      ORDER BY id
      `
    );

  if (!result.rows.length) {
    await bot.sendMessage(
      userId,
      "🍽️ Menu မရှိသေးပါ။"
    );

    return;
  }

  for (
    const product
    of result.rows
  ) {
    await bot.sendPhoto(
      userId,
      product.photo_file_id,
      {
        caption:
          `🍽️ ${product.name}\n\n` +
          `💰 ${money(product.price)}\n\n` +
          `${product.description || ""}`
      }
    );
  }
}

async function showEditMenuList(
  userId
) {
  const result =
    await pool.query(
      `
      SELECT *
      FROM products
      ORDER BY id
      `
    );

  if (!result.rows.length) {
    await bot.sendMessage(
      userId,
      "🍽️ Menu မရှိသေးပါ။"
    );

    return;
  }

  const buttons =
    result.rows.map(
      (product) => [
        {
          text:
            `✏️ ${product.name}`,
          callback_data:
            `editproduct_${product.id}`
        }
      ]
    );

  await bot.sendMessage(
    userId,
    "✏️ ပြင်ချင်တဲ့ Menu ကိုရွေးပါ။",
    {
      reply_markup: {
        inline_keyboard:
          buttons
      }
    }
  );
}

async function showEditOptions(
  userId,
  productId
) {
  const result =
    await pool.query(
      `
      SELECT *
      FROM products
      WHERE id = $1
      `,
      [productId]
    );

  if (!result.rows.length) {
    return;
  }

  const product =
    result.rows[0];

  await bot.sendMessage(
    userId,
    `✏️ ${product.name}\n\nဘာကိုပြင်မလဲ?`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                "📝 Name",
              callback_data:
                `editname_${productId}`
            },
            {
              text:
                "💰 Price",
              callback_data:
                `editprice_${productId}`
            }
          ],
          [
            {
              text:
                "📄 Description",
              callback_data:
                `editdesc_${productId}`
            },
            {
              text:
                "📸 Photo",
              callback_data:
                `editphoto_${productId}`
            }
          ]
        ]
      }
    }
  );
}

async function updateProductName(
  userId,
  productId,
  name
) {
  if (!name.trim()) {
    return;
  }

  await pool.query(
    `
    UPDATE products
    SET name = $1
    WHERE id = $2
    `,
    [
      name.trim(),
      productId
    ]
  );

  userStates.delete(userId);

  await bot.sendMessage(
    userId,
    "✅ Menu Name ပြင်ပြီးပါပြီ။",
    {
      reply_markup:
        adminKeyboard()
    }
  );
}

async function updateProductPrice(
  userId,
  productId,
  priceText
) {
  const price =
    Number(
      priceText.replace(/,/g, "")
    );

  if (!Number.isFinite(price)) {
    await bot.sendMessage(
      userId,
      "❌ စျေးနှုန်းမှန်ကန်စွာထည့်ပါ။"
    );

    return;
  }

  await pool.query(
    `
    UPDATE products
    SET price = $1
    WHERE id = $2
    `,
    [
      price,
      productId
    ]
  );

  userStates.delete(userId);

  await bot.sendMessage(
    userId,
    "✅ Price ပြင်ပြီးပါပြီ။",
    {
      reply_markup:
        adminKeyboard()
    }
  );
}

async function updateProductDescription(
  userId,
  productId,
  description
) {
  await pool.query(
    `
    UPDATE products
    SET description = $1
    WHERE id = $2
    `,
    [
      description,
      productId
    ]
  );

  userStates.delete(userId);

  await bot.sendMessage(
    userId,
    "✅ Description ပြင်ပြီးပါပြီ။",
    {
      reply_markup:
        adminKeyboard()
    }
  );
}

async function editMenuPhoto(msg) {
  const userId =
    msg.from.id;

  const state =
    userStates.get(userId);

  if (!state) return;

  const photo =
    msg.photo[
      msg.photo.length - 1
    ];

  await pool.query(
    `
    UPDATE products
    SET photo_file_id = $1
    WHERE id = $2
    `,
    [
      photo.file_id,
      state.productId
    ]
  );

  userStates.delete(userId);

  await bot.sendMessage(
    userId,
    "✅ Photo ပြင်ပြီးပါပြီ။",
    {
      reply_markup:
        adminKeyboard()
    }
  );
}

async function showDeleteMenuList(
  userId
) {
  const result =
    await pool.query(
      `
      SELECT *
      FROM products
      ORDER BY id
      `
    );

  if (!result.rows.length) {
    await bot.sendMessage(
      userId,
      "🍽️ Menu မရှိသေးပါ။"
    );

    return;
  }

  const buttons =
    result.rows.map(
      (product) => [
        {
          text:
            `🗑 ${product.name}`,
          callback_data:
            `deleteproduct_${product.id}`
        }
      ]
    );

  await bot.sendMessage(
    userId,
    "🗑 ဖျက်ချင်တဲ့ Menu ကိုရွေးပါ။",
    {
      reply_markup: {
        inline_keyboard:
          buttons
      }
    }
  );
}

async function deleteProduct(
  userId,
  productId
) {
  const result =
    await pool.query(
      `
      SELECT *
      FROM products
      WHERE id = $1
      `,
      [productId]
    );

  if (!result.rows.length) {
    return;
  }

  await pool.query(
    `
    DELETE FROM carts
    WHERE product_id = $1
    `,
    [productId]
  );

  await pool.query(
    `
    DELETE FROM products
    WHERE id = $1
    `,
    [productId]
  );

  await bot.sendMessage(
    userId,
    `🗑 ${result.rows[0].name}\n\nဖျက်ပြီးပါပြီ။`,
    {
      reply_markup:
        adminKeyboard()
    }
  );
}

async function showActiveOrders(
  userId
) {
  const result =
    await pool.query(
      `
      SELECT *
      FROM orders
      WHERE status NOT IN
      ('delivered','cancelled')
      ORDER BY created_at ASC
      `
    );

  if (!result.rows.length) {
    await bot.sendMessage(
      userId,
      "📦 Active Order မရှိသေးပါ။"
    );

    return;
  }

  for (
    const order
    of result.rows
  ) {
    const items =
      await pool.query(
        `
        SELECT *
        FROM order_items
        WHERE order_id = $1
        ORDER BY id
        `,
        [order.id]
      );

    let message =
      `🧾 #${String(order.order_number).padStart(4, "0")}\n\n`;

    for (
      const item
      of items.rows
    ) {
      message +=
        `🍽️ ${item.product_name} × ${item.quantity}\n`;
    }

    message +=
      `\n💰 ${money(order.total)}\n` +
      `📌 ${order.status}\n` +
      `📱 ${order.phone}\n` +
      `📍 ${order.address}`;

    let keyboard = [];

    if (order.status === "pending") {
      keyboard = [
        [
          {
            text:
              "✅ Accept",
            callback_data:
              `accept_${order.id}`
          },
          {
            text:
              "❌ Cancel",
            callback_data:
              `cancel_${order.id}`
          }
        ]
      ];
    }

    if (order.status === "accepted") {
      keyboard = [
        [
          {
            text:
              "👨‍🍳 Preparing",
            callback_data:
              `preparing_${order.id}`
          }
        ]
      ];
    }

    if (order.status === "preparing") {
      keyboard = [
        [
          {
            text:
              "🛵 Delivering",
            callback_data:
              `delivering_${order.id}`
          }
        ]
      ];
    }

    if (order.status === "delivering") {
      keyboard = [
        [
          {
            text:
              "🎉 Delivered",
            callback_data:
              `delivered_${order.id}`
          }
        ]
      ];
    }

    await bot.sendMessage(
      userId,
      message,
      {
        reply_markup: {
          inline_keyboard:
            keyboard
        }
      }
    );
  }
}

async function showOrderHistory(
  userId
) {
  const result =
    await pool.query(
      `
      SELECT *
      FROM orders
      ORDER BY created_at DESC
      LIMIT 50
      `
    );

  if (!result.rows.length) {
    await bot.sendMessage(
      userId,
      "📊 Order History မရှိသေးပါ။"
    );

    return;
  }

  let message =
    "📊 Order History\n\n";

  for (
    const order
    of result.rows
  ) {
    message +=
      `#${String(order.order_number).padStart(4, "0")} | ` +
      `${money(order.total)} | ` +
      `${order.status}\n`;
  }

  await bot.sendMessage(
    userId,
    message
  );
}

bot.on(
  "callback_query",
  async (query) => {
    if (
      query.data &&
      query.data.startsWith("noop_")
    ) {
      try {
        await bot.answerCallbackQuery(
          query.id
        );
      } catch {}
    }
  }
);

const webhookPath =
  `/telegram/${WEBHOOK_SECRET}`;

app.post(
  webhookPath,
  (req, res) => {
    bot.processUpdate(
      req.body
    );

    res.sendStatus(200);
  }
);

app.get(
  "/",
  (req, res) => {
    res.send(
      "Telegram Food Shop Bot is running."
    );
  }
);

async function startServer() {
  try {
    await initDatabase();

    app.listen(
      PORT,
      async () => {
        console.log(
          `Server running on port ${PORT}`
        );

        if (WEBHOOK_URL) {
          const fullWebhookUrl =
            `${WEBHOOK_URL.replace(/\/$/, "")}${webhookPath}`;

          try {
            await bot.setWebHook(
              fullWebhookUrl
            );

            console.log(
              "Webhook set successfully"
            );
          } catch (error) {
            console.error(
              "Webhook error:",
              error.message
            );
          }
        }
      }
    );
  } catch (error) {
    console.error(
      "Startup error:",
      error
    );

    process.exit(1);
  }
}

startServer();
