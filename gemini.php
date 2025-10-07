<?php
require_once 'config/db.php';
include 'Telegram.php';

$telegram = new Telegram('8267056539:AAHUjlj1dK5yVJl0U0UiRq13_U0-XxIRAvg');
$zibal_merchant = "zibal";

$resultTelegram = $telegram->getData();
$chat_id = $telegram->ChatID();
$text = $telegram->Text();
$mesasge_id = false;
if (isset($resultTelegram['callback_query'])) $mesasge_id = $resultTelegram['callback_query']['message']['message_id'];

// My Functions

function sendMessage($chat_id, $text, $keyboard = false, $editMessage = false)
{
    global $telegram;
    $content = array('chat_id' => $chat_id, 'text' => $text, 'parse_mode' => 'HTML');
    if ($keyboard) $content["reply_markup"] = $keyboard;
    if ($editMessage) {
        $content['message_id'] = $editMessage;
        return $telegram->editMessageText($content);
    }
    return $telegram->sendMessage($content);
}

function sendPhoto($chat_id, $photo_url, $caption, $keyboard = false)
{
    global $telegram;
    $content = array('chat_id' => $chat_id, 'photo' => $photo_url, 'caption' => $caption, 'parse_mode' => 'HTML');
    if ($keyboard) $content["reply_markup"] = $keyboard;
    return $telegram->sendPhoto($content);
}

function sendMainKeyboardMenu($chat_id, $mesasge_id = false)
{
    global $telegram;
    $option = array(
        array($telegram->buildInlineKeyBoardButton("خریــــد محصول 🛍️", '', 'buy_product')),
        array($telegram->buildInlineKeyBoardButton("سبد خرید 🛒", '', 'view_cart'), $telegram->buildInlineKeyBoardButton("سفارشات من ✉️", '', 'my_orders')),
        array($telegram->buildInlineKeyBoardButton("راهنما ❓", '', 'help'), $telegram->buildInlineKeyBoardButton("پشتیبانی 🗣️", '', 'support')),
    );
    $keyb = $telegram->buildInlineKeyBoard($option);
    $text = "سلام <b>" . $telegram->FirstName() . "</b>\n";
    $text .= "به فروشگاه آنلاین مدرس انگلیسی خوش آمدید ❤️\n\n";
    $text .= "⭐️ دروه های آنلاین و کتاب های تخصصی آیلتس\n";

    sendMessage($chat_id, $text, $keyb, $mesasge_id);
}

function query($action, $table, $fields = false, $wheres = false, $isfetchall = false, $order_by = false)
{
    global $conn, $chat_id;

    if ($action == "CREATE") {
        $values = [];
        $sql = "INSERT INTO $table SET ";
        $item = 1;
        foreach ($fields as $key => $value) {
            $sql .= ($key . '=? ');
            array_push($values, $value);
            if ($item < count($fields)) $sql .= ', ';
            $item++;
        }
        $statment = $conn->prepare($sql);
        for ($i = 1; $i <= count($fields); $i++)
            $statment->bindValue($i, $values[$i - 1]);
        $statment->execute();
        return $conn->lastInsertId();
    }

    if ($action == "UPDATE") {
        $values = [];
        $sql = "UPDATE $table SET ";
        $item = 1;
        foreach ($fields as $key => $value) {
            $sql .= ($key . '=? ');
            array_push($values, $value);
            if ($item < count($fields)) $sql .= ', ';
            $item++;
        }
        if ($wheres) {
            $sql .= "WHERE ";
            $item = 1;
            foreach ($wheres as $where) {
                $sql .= $where["key"] . $where["condition"] . "?";
                array_push($values, $where["value"]);
                if ($item < count($wheres)) $sql .= ' AND ';
                $item++;
            }
        }
        $statment = $conn->prepare($sql);
        for ($i = 1; $i <= count($values); $i++)
            $statment->bindValue($i, $values[$i - 1]);
        $statment->execute();
    }

    if ($action == "SELECT") {
        $values = [];
        $sql = "SELECT * FROM $table ";
        if ($wheres) {
            $sql .= "WHERE ";
            $item = 1;
            foreach ($wheres as $where) {
                $sql .= $where["key"] . $where["condition"] . "?";
                array_push($values, $where["value"]);
                if ($item < count($wheres)) $sql .= ' AND ';
                $item++;
            }
        }
        if ($order_by) $sql .= (" ORDER BY " . $order_by);
        $statment = $conn->prepare($sql);
        for ($i = 1; $i <= count($values); $i++)
            $statment->bindValue($i, $values[$i - 1]);
        $statment->execute();
        if ($isfetchall) return $statment->fetchAll(PDO::FETCH_OBJ);
        return $statment->fetch(PDO::FETCH_OBJ);
    }
}

// پردازش فشار دکمه‌ها
if (isset($resultTelegram['callback_query'])) {
    $callback_data = $resultTelegram['callback_query']['data'];

    // دسته‌بندی انتخاب کردن
    if (strpos($callback_data, 'category_') === 0) {
        $category_id = str_replace('category_', '', $callback_data);
        $user_detail = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);

        $products = query("SELECT", "products", false, [["key" => "category_id", "condition" => "=", "value" => $category_id], ["key" => "status", "condition" => "=", "value" => "enable"]], true);

        $text = "📅 ابتدا محصول مورد نظر خود را انتخاب کنید.\n\n";
        $text .= "▫️ دسته بندی: ✨ کتاب+ ✨\n\n";
        $text .= "💡 پس از انتخاب محصول، اطلاعات کامل شامل قیمت و ویژگی‌های آن برای شما نمایش داده می‌شود.\n\n";

        $option = [];
        foreach ($products as $product) {
            $option[] = array($telegram->buildInlineKeyBoardButton($product->title, '', 'product_' . $product->id));
        }

        $option[] = array($telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'buy_product'));
        $keyb = $telegram->buildInlineKeyBoard($option);

        sendMessage($chat_id, $text, $keyb, $mesasge_id);
    }

    // محصول انتخاب کردن
    if (strpos($callback_data, 'product_') === 0) {
        $product_id = str_replace('product_', '', $callback_data);
        $product = query("SELECT", "products", false, [["key" => "id", "condition" => "=", "value" => $product_id]]);

        $text = "";
        // اگر محصول عکس داشت، آن را به صورت نامرئی به متن اضافه کن
        if ($product->image_url) {
            $text .= "<a href='" . $product->image_url . "'>&#8203;</a>";
        }

        $text .= "<b>💸 مبلغ:</b> " . number_format($product->price) . " تومان\n\n";
        $text .= "<b>▫️ دسته بندی:</b> ✨ کتاب+ ✨\n\n";
        $text .= "<b>▫️ محصول:</b> ✨ " . $product->title . " ✨\n\n";
        $text .= "<b>▫️ توضیحات:</b>\n" . $product->description . "\n\n";
        $text .= "<b>✍️ نویسنده/مدرس:</b> " . $product->author . "\n";

        $option = array(
            array(
                $telegram->buildInlineKeyBoardButton("➖", '', 'qty_minus_' . $product_id),
                $telegram->buildInlineKeyBoardButton("1", '', 'qty_display_1'), // یک callback بی‌اثر بدهید
                $telegram->buildInlineKeyBoardButton("➕", '', 'qty_plus_' . $product_id)
            ),
            array($telegram->buildInlineKeyBoardButton("افزودن به سبد خرید ✅", '', 'add_to_cart_' . $product_id . '_1')), // تعداد را هم به callback اضافه کنید
            array($telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'category_' . $product->category_id)), // بازگشت به لیست محصولات همان دسته
        );
        $keyb = $telegram->buildInlineKeyBoard($option);

        // همیشه پیام را ویرایش کن
        sendMessage($chat_id, $text, $keyb, $mesasge_id);

    }

    // افزودن به سبد خرید
    if (strpos($callback_data, 'add_to_cart_') === 0) {
        $product_id = str_replace('add_to_cart_', '', $callback_data);
        $user_detail = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);

        $active_order = query("SELECT", "orders", false, [["key" => "status", "condition" => "=", "value" => "pending"], ["key" => "user_id", "condition" => "=", "value" => $user_detail->id]]);

        if (!$active_order) {
            $order_id = query("CREATE", "orders", ["user_id" => $user_detail->id, "time" => time(), "status" => "pending"]);
            $active_order = new stdClass();
            $active_order->id = $order_id;
        }

        query("CREATE", "orders_item", ["order_id" => $active_order->id, "product_id" => $product_id, "quantity" => 1]);
        sendMessage($chat_id, "✅ محصول مورد نظر با موفقیت به سبد خرید اضافه شد!", false, $mesasge_id);
    }

    // مشاهده سبد خرید
    if ($callback_data == 'view_cart' || $callback_data == 'cart') {
        $user_detail = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);
        $active_order = query("SELECT", "orders", false, [["key" => "status", "condition" => "=", "value" => "pending"], ["key" => "user_id", "condition" => "=", "value" => $user_detail->id]]);

        if (!$active_order) {
            $option = array(
                array($telegram->buildInlineKeyBoardButton("بازگشت به منوی اصلی 🏠", '', 'start')),
            );
            $keyb = $telegram->buildInlineKeyBoard($option);
            sendMessage($chat_id, "📪 سبد خرید شما خالی هست", $keyb, $mesasge_id);
        } else {
            $sql = "SELECT orders_item.id AS orderitem_id, orders_item.quantity, products.id as product_id, products.title as product_title, products.price as product_price FROM `orders_item`
                    LEFT JOIN products ON orders_item.product_id = products.id
                    WHERE orders_item.order_id=" . $active_order->id;

            $statment = $conn->query($sql);
            $statment->execute();
            $products = $statment->fetchAll(PDO::FETCH_OBJ);

            $text = "<b>🛒 سبد خرید شما:</b>\n\n";
            $total_price = 0;
            $item_count = 0;

            foreach ($products as $product) {
                $item_total = $product->product_price * $product->quantity;
                $total_price += $item_total;
                $item_count++;
                $text .= "📦 <b>" . $product->product_title . "</b>\n";
                $text .= "🔢 تعداد: " . $product->quantity . "\n";
                $text .= "💵 قیمت: " . number_format($item_total) . " تومان\n";
                $text .= "🗑️ حذف: /delete_item_" . $product->orderitem_id . "\n";
                $text .= "─────────────────\n";
            }

            $text .= "\n✅ <b>جمع کل:</b> " . number_format($total_price) . " تومان\n";

            $option = array(
                array($telegram->buildInlineKeyBoardButton("تکمیل خرید 💳", '', 'checkout')),
                array($telegram->buildInlineKeyBoardButton("حذف سبد خرید ❌", '', 'clear_cart'), $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'start')),
            );
            $keyb = $telegram->buildInlineKeyBoard($option);
            sendMessage($chat_id, $text, $keyb, $mesasge_id);
        }
    }

    // حذف کل سبد خرید
    if ($callback_data == 'clear_cart') {
        $user_detail = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);
        query("UPDATE", "orders", ["status" => "cancel"], [["key" => "status", "condition" => "=", "value" => "pending"], ["key" => "user_id", "condition" => "=", "value" => $user_detail->id]]);
        sendMessage($chat_id, "⛔📝 سبد خرید شما با موفقیت خالی شد", false, $mesasge_id);
        sendMainKeyboardMenu($chat_id, $mesasge_id);
    }

    // تکمیل خرید
    if ($callback_data == 'checkout') {
        $user_detail = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);
        $active_order = query("SELECT", "orders", false, [["key" => "status", "condition" => "=", "value" => "pending"], ["key" => "user_id", "condition" => "=", "value" => $user_detail->id]]);

        // ذخیره مرحله checkout
        query("CREATE", "user_checkout_state", ["user_id" => $user_detail->id, "order_id" => $active_order->id, "step" => 1]);

        $text = "مرحله 1️⃣\n\n";
        $text .= "لطفاً نام و نام خانوادگی خود را وارد کنید:\n";
        $text .= "(به صورت: نام نام‌خانوادگی)\n\n";
        $text .= "مثال: علی محمدی";

        sendMessage($chat_id, $text, false, $mesasge_id);
    }

    // دسته‌بندی انتخاب کردن - صفحه اول
    if ($callback_data == 'buy_product') {
        $categories = query("SELECT", "categories", false, [["key" => "status", "condition" => "=", "value" => "enable"]], true);

        $text = "⭐️ <b>لطفا دسته‌بندی مد نظر خود را انتخاب کنید</b>\n\n";

        $option = [];
        foreach ($categories as $cat) {
            $option[] = array($telegram->buildInlineKeyBoardButton($cat->icon . " " . $cat->name, '', 'category_' . $cat->id));
        }
        $option[] = array($telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start'));

        $keyb = $telegram->buildInlineKeyBoard($option);
        sendMessage($chat_id, $text, $keyb, $mesasge_id);
    }

    // پشتیبانی
    if ($callback_data == 'support') {
        $setting = query("SELECT", "settings", false, [["key" => "setting_key", "condition" => "=", "value" => "support"]]);
        $text = "🗣️ <b>تماس با پشتیبانی</b>\n\n";
        $text .= "شما می‌توانید از طریق آیدی تلگرام زیر تماس بگیرید:\n\n";
        $text .= "<b>" . ($setting ? $setting->setting_value : "@Ielts_with_us_updated") . "</b>";

        $option = array(
            array($telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start')),
        );
        $keyb = $telegram->buildInlineKeyBoard($option);
        sendMessage($chat_id, $text, $keyb, $mesasge_id);
    }

    // سفارشات من
    if ($callback_data == 'my_orders') {
        $user_detail = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);
        $orders = query("SELECT", "orders", false, [["key" => "user_id", "condition" => "=", "value" => $user_detail->id], ["key" => "status", "condition" => "!=", "value" => "pending"]], true, "id DESC LIMIT 5");

        if (!$orders || count($orders) == 0) {
            $text = "📑 <b>سفارشات شما</b>\n\n";
            $text .= "هنوز سفارش تکمیل‌شده‌ای ندارید.";

            $option = array(
                array($telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start')),
            );
            $keyb = $telegram->buildInlineKeyBoard($option);
            sendMessage($chat_id, $text, $keyb, $mesasge_id);
        } else {
            $text = "📑 <b>5 سفارش آخر شما:</b>\n\n";

            foreach ($orders as $order) {
                $order_details = query("SELECT", "order_details", false, [["key" => "order_id", "condition" => "=", "value" => $order->id]]);

                $status_text = '';
                if ($order->status == 'payed') $status_text = '✅ پرداخت شده';
                elseif ($order->status == 'reject') $status_text = '❌ رد شده';
                elseif ($order->status == 'cancel') $status_text = '🚫 لغو شده';

                $text .= "🆔 <b>سفارش #" . $order->id . "</b>\n";
                if ($order_details) {
                    $text .= "👤 " . $order_details->first_name . " " . $order_details->last_name . "\n";
                }
                $text .= "💵 جمع کل: " . number_format(0) . " تومان\n"; // محاسبه کنید
                $text .= "📌 وضعیت: " . $status_text . "\n";
                $text .= "────\n\n";
            }

            $option = array(
                array($telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start')),
            );
            $keyb = $telegram->buildInlineKeyBoard($option);
            sendMessage($chat_id, $text, $keyb, $mesasge_id);
        }
    }

    // راهنما
    if ($callback_data == 'help') {
        $text = "❓ <b>راهنمای استفاده از ربات</b>\n\n";
        $text .= "1️⃣ <b>خریداری محصول:</b>\n";
        $text .= "   • بر روی گزینه 'خریداری محصول' کلیک کنید\n";
        $text .= "   • دسته‌بندی را انتخاب کنید\n";
        $text .= "   • محصول را انتخاب کنید و مقدار را تعیین کنید\n\n";
        $text .= "2️⃣ <b>سبد خرید:</b>\n";
        $text .= "   • تمام محصولات انتخاب‌شده در سبد خرید ذخیره می‌شوند\n";
        $text .= "   • می‌توانید محصولات را حذف کنید\n\n";
        $text .= "3️⃣ <b>تکمیل خرید:</b>\n";
        $text .= "   • اطلاعات فردی را درست کنید\n";
        $text .= "   • عکس فیش واریزی را ارسال کنید\n\n";
        $text .= "4️⃣ <b>پیگیری سفارش:</b>\n";
        $text .= "   • بر روی 'سفارشات من' کلیک کنید\n";
        $text .= "   • وضعیت سفارش را مشاهده کنید";

        $option = array(
            array($telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start')),
        );
        $keyb = $telegram->buildInlineKeyBoard($option);
        sendMessage($chat_id, $text, $keyb, $mesasge_id);
    }

    // بازگشت به منوی اصلی
    if ($callback_data == 'start') {
        sendMainKeyboardMenu($chat_id, $mesasge_id);
    }
}

// پردازش پیام‌های متنی
if (!isset($resultTelegram['callback_query'])) {

    if ($text == "/start") {
        $getUser = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);
        if (!$getUser) {
            query("CREATE", "users", ["chat_id" => $chat_id, "name" => $telegram->FirstName(), "status" => "enable"]);
        }
        sendMainKeyboardMenu($chat_id);
    }

    // پردازش مراحل checkout
    $user_detail = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);
    $checkout_state = query("SELECT", "user_checkout_state", false, [["key" => "user_id", "condition" => "=", "value" => $user_detail->id]], false, "id DESC");

    if ($checkout_state) {
        $step = $checkout_state->step;

        // مرحله 1: دریافت نام و نام خانوادگی
        if ($step == 1 && $text && $text[0] != '/') {
            $names = explode(' ', $text);
            if (count($names) >= 2) {
                $first_name = $names[0];
                $last_name = implode(' ', array_slice($names, 1));

                // بروزرسانی state
                $data = json_encode(["first_name" => $first_name, "last_name" => $last_name]);
                query("UPDATE", "user_checkout_state", ["step" => 2, "step_data" => $data], [["key" => "id", "condition" => "=", "value" => $checkout_state->id]]);

                $text = "مرحله 2️⃣\n\n";
                $text .= "لطفاً آدرس خود را وارد کنید:\n";
                $text .= "(آدرس کامل شهر، خیابان، پلاک و...)";

                sendMessage($chat_id, $text);
            } else {
                sendMessage($chat_id, "❌ لطفاً نام و نام خانوادگی را به صورت صحیح وارد کنید:\nمثال: علی محمدی");
            }
        }

        // مرحله 2: دریافت آدرس
        if ($step == 2 && $text && $text[0] != '/') {
            $step_data = json_decode($checkout_state->step_data, true);
            $step_data['address'] = $text;
            $data = json_encode($step_data);

            query("UPDATE", "user_checkout_state", ["step" => 3, "step_data" => $data], [["key" => "id", "condition" => "=", "value" => $checkout_state->id]]);

            $text = "مرحله 3️⃣\n\n";
            $text .= "لطفاً شماره تلفن خود را وارد کنید:\n";
            $text .= "(فقط اعداد - مثال: 09123456789)";

            sendMessage($chat_id, $text);
        }

        // مرحله 3: دریافت شماره تلفن
        if ($step == 3 && $text && $text[0] != '/') {
            if (preg_match('/^09\d{9}$/', $text)) {
                $step_data = json_decode($checkout_state->step_data, true);
                $step_data['phone'] = $text;

                // محاسبه مجموع سفارش
                $sql = "SELECT SUM(products.price * orders_item.quantity) as total FROM `orders_item`
                        LEFT JOIN products ON orders_item.product_id = products.id
                        WHERE orders_item.order_id=" . $checkout_state->order_id;

                $statment = $conn->query($sql);
                $statment->execute();
                $result = $statment->fetch(PDO::FETCH_OBJ);
                $total_price = $result->total ? $result->total : 0;

                $step_data['total_price'] = $total_price;
                $data = json_encode($step_data);

                query("UPDATE", "user_checkout_state", ["step" => 4, "step_data" => $data], [["key" => "id", "condition" => "=", "value" => $checkout_state->id]]);

                $text = "مرحله 4️⃣\n\n";
                $text .= "💳 <b>شماره کارت برای واریز:</b>\n";
                $text .= "5047061137173049\n";
                $text .= $step_data['first_name'] . " " . $step_data['last_name'] . "\n\n";
                $text .= "💰 <b>مبلغ کل:</b> " . number_format($total_price) . " تومان\n\n";
                $text .= "لطفاً پس از واریز، عکس فیش واریزی خود را ارسال کنید:";

                sendMessage($chat_id, $text);
            } else {
                sendMessage($chat_id, "❌ شماره تلفن وارد شده صحیح نیست.\nلطفاً شماره تلفن خود را به صورت صحیح وارد کنید:\nمثال: 09123456789");
            }
        }
    }

    // دریافت عکس فیش
    if (isset($resultTelegram['message']['photo'])) {
        $user_detail = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);
        $checkout_state = query("SELECT", "user_checkout_state", false, [["key" => "user_id", "condition" => "=", "value" => $user_detail->id]], false, "id DESC");

        if ($checkout_state && $checkout_state->step == 4) {
            $step_data = json_decode($checkout_state->step_data, true);

            // دریافت فایل عکس
            $file_id = $resultTelegram['message']['photo'][count($resultTelegram['message']['photo']) - 1]['file_id'];
            $file = $telegram->getFile($file_id);
            $file_path = $file->file_path;

            // ذخیره در سرور
            $image_name = 'receipt_' . $checkout_state->order_id . '_' . time() . '.jpg';
            $image_url = 'uploads/' . $image_name;

            // دانلود و ذخیره عکس
            $file_url = 'https://api.telegram.org/file/bot8267056539:AAHUjlj1dK5yVJl0U0UiRq13_U0-XxIRAvg/' . $file_path;
            file_put_contents($image_url, file_get_contents($file_url));

            // ذخیره اطلاعات سفارش
            $order_detail_id = query("CREATE", "order_details", [
                "order_id" => $checkout_state->order_id,
                "first_name" => $step_data['first_name'],
                "last_name" => $step_data['last_name'],
                "address" => $step_data['address'],
                "phone_number" => $step_data['phone'],
                "receipt_image_url" => $image_url,
                "status" => "pending"
            ]);

            // بروزرسانی وضعیت سفارش به payed
            query("UPDATE", "orders", ["status" => "payed"], [["key" => "id", "condition" => "=", "value" => $checkout_state->order_id]]);

            // پاک کردن checkout state
            query("UPDATE", "user_checkout_state", ["step" => 0], [["key" => "id", "condition" => "=", "value" => $checkout_state->id]]);

            $text = "✅ <b>اطلاعات شما ثبت شد و سفارش به ادمین ارسال گردید.</b>\n\n";
            $text .= "از خرید شما متشکریم 🙏\n\n";
            $text .= "📌 <b>جزئیات سفارش:</b>\n";
            $text .= "🆔 شماره سفارش: #" . $checkout_state->order_id . "\n";
            $text .= "👤 نام: " . $step_data['first_name'] . " " . $step_data['last_name'] . "\n";
            $text .= "📍 آدرس: " . $step_data['address'] . "\n";
            $text .= "📱 تلفن: " . $step_data['phone'] . "\n";
            $text .= "💵 مبلغ کل: " . number_format($step_data['total_price']) . " تومان\n";
            $text .= "⏰ وضعیت: ⏳ در انتظار تایید\n\n";
            $text .= "شما می‌توانید در بخش 'سفارشات من' وضعیت سفارش خود را مشاهده کنید.";

            $option = array(
                array($telegram->buildInlineKeyBoardButton("بازگشت به منوی اصلی 🏠", '', 'start')),
            );
            $keyb = $telegram->buildInlineKeyBoard($option);

            sendMessage($chat_id, $text, $keyb);
        }
    }
}