<?php
// user_handler.php

if (isset($resultTelegram['callback_query'])) {
    $callback_data = $resultTelegram['callback_query']['data'];

    if ($callback_data === 'noop') {
        exit;
    }

    // دسته‌بندی‌ها
    if (strpos($callback_data, 'category_') === 0) {
        global $telegram;
        $category_id = str_replace('category_', '', $callback_data);

        // ✅ مرحله ۱: اطلاعات دسته‌بندی را از دیتابیس دریافت می‌کنیم
        $category = query("SELECT", "categories", false, [["key" => "id", "condition" => "=", "value" => $category_id]]);

        // دریافت لیست محصولات این دسته‌بندی
        $products = query("SELECT", "products", false, [
            ["key" => "category_id", "condition" => "=", "value" => $category_id],
            ["key" => "status", "condition" => "=", "value" => "enable"]
        ], true);

        // مقدار پیش‌فرض در صورتی که دسته‌بندی پیدا نشد
        $category_display_name = "انتخاب شده";
        if ($category) {
            // اگر دسته‌بندی پیدا شد، نام و آیکون آن را می‌سازیم
            $category_display_name = ($category->icon ?? '✨') . " " . htmlspecialchars($category->name);
        }

        $text = "📅 ابتدا محصول مورد نظر خود را انتخاب کنید.\n\n";

        // ✅ مرحله ۲: از نام داینامیک در متن پیام استفاده می‌کنیم
        $text .= "▫️ دسته بندی: " . $category_display_name . "\n\n";

        $text .= "💡 پس از انتخاب محصول، اطلاعات کامل شامل قیمت و ویژگی‌های آن برای شما نمایش داده می‌شود.\n\n";

        $option = [];

        // اگر محصولی در این دسته‌بندی نبود، به کاربر اطلاع می‌دهیم
        if (!$products || count($products) == 0) {
            $text = "❌ متاسفانه محصول فعالی در دسته‌بندی «" . ($category->name ?? '') . "» وجود ندارد.";
        } else {
            foreach ($products as $product) {
                $option[] = array($telegram->buildInlineKeyBoardButton($product->title, '', 'product_' . $product->id));
            }
        }

        $option[] = array($telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'buy_product'));
        $keyb = $telegram->buildInlineKeyBoard($option);
        sendMessage($chat_id, $text, $keyb, $mesasge_id);
        exit;
    }

    // نمایش محصول
    if (strpos($callback_data, 'product_') === 0) {
        $product_id = str_replace('product_', '', $callback_data);
        renderProductCard($chat_id, $product_id, 1, $mesasge_id);
        exit;
    }

    // افزایش تعداد
    if (strpos($callback_data, 'qty_plus_') === 0) {
        $parts = explode('_', $callback_data); // qty_plus_{pid}_{qty}
        $product_id = intval($parts[2] ?? 0);
        $current_qty = intval($parts[3] ?? 1);
        $new_qty = min(99, max(1, $current_qty + 1));
        renderProductCard($chat_id, $product_id, $new_qty, $mesasge_id);
        exit;
    }

    // کاهش تعداد
    if (strpos($callback_data, 'qty_minus_') === 0) {
        $parts = explode('_', $callback_data); // qty_minus_{pid}_{qty}
        $product_id = intval($parts[2] ?? 0);
        $current_qty = intval($parts[3] ?? 1);
        $new_qty = min(99, max(1, $current_qty - 1));
        renderProductCard($chat_id, $product_id, $new_qty, $mesasge_id);
        exit;
    }

    // افزودن به سبد
    if (strpos($callback_data, 'add_to_cart_') === 0) {
        $parts = explode('_', $callback_data); // add_to_cart_{pid}_{qty?}
        $product_id = intval($parts[3] ?? 0);
        $qty = max(1, min(99, intval($parts[4] ?? 1)));



        // --- شروع بخش جدید: چک کردن موجودی ---
        $product = query("SELECT", "products", false, [["key"=>"id","condition"=>"=","value"=>$product_id]]);
        if (!$product || $product->inventory < $qty) {
            $err_msg = "❌ متاسفانه موجودی این محصول کافی نیست.";
            if ($product) {
                $err_msg .= "\nحداکثر موجودی قابل سفارش: " . $product->inventory . " عدد";
            }

            // ساخت دکمه بازگشت
            global $telegram;
            $back_callback = $product ? 'product_' . $product->id : 'buy_product';
            $keyb = $telegram->buildInlineKeyBoard([
                [ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', $back_callback) ]
            ]);
            
            // ارسال پیام خطا همراه با دکمه
            sendMessage($chat_id, $err_msg, $keyb, $mesasge_id);
            exit;
        }




        $user_detail = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);
        if (!$user_detail) {
            sendMessage($chat_id, "❌ خطا: کاربر یافت نشد.", false, $mesasge_id);
            exit;
        }

        $active_order = query("SELECT", "orders", false, [
            ["key" => "status", "condition" => "=", "value" => "pending"],
            ["key" => "user_id", "condition" => "=", "value" => $user_detail->id]
        ]);
        if (!$active_order) {
            $track_id = generateTrackId();
            $order_id = query("CREATE", "orders", ["user_id" => $user_detail->id, "time" => time(), "user_chat_id" => $chat_id, "status" => "pending", "trackId" => $track_id]);
            $active_order = (object) ["id" => $order_id];
        }

        $existing = query("SELECT", "orders_item", false, [
            ["key" => "order_id", "condition" => "=", "value" => $active_order->id],
            ["key" => "product_id", "condition" => "=", "value" => $product_id]
        ]);

        $quantity_in_cart = $existing ? intval($existing->quantity) : 0;
        if ($product->inventory < ($quantity_in_cart + $qty)) {
            $err_msg = "❌ شما قبلاً {$quantity_in_cart} عدد از این محصول را در سبد دارید.\n";
            $err_msg .= "موجودی انبار (" . $product->inventory . " عدد) برای اضافه کردن {$qty} عدد دیگر کافی نیست.";
            sendMessage($chat_id, $err_msg, false, $mesasge_id);
            exit;
        }


        if ($existing) {
            $new_q = max(1, min(999, intval($existing->quantity) + $qty));
            query("UPDATE", "orders_item", ["quantity" => $new_q], [["key" => "id", "condition" => "=", "value" => $existing->id]]);
        } else {
            query("CREATE", "orders_item", ["order_id" => $active_order->id, "product_id" => $product_id, "quantity" => $qty]);
        }

        global $telegram;
        $keyb = $telegram->buildInlineKeyBoard([
            [$telegram->buildInlineKeyBoardButton("مشاهده سبد 🛒", '', 'view_cart')],
            [$telegram->buildInlineKeyBoardButton("ادامه خرید 🔎", '', 'buy_product')],
        ]);
        sendMessage($chat_id, "✅ محصول با تعداد <b>{$qty}</b> به سبد خرید اضافه شد.", $keyb, $mesasge_id);
        exit;
    }

    // مشاهده سبد
    if ($callback_data == 'view_cart' || $callback_data == 'cart') {
        renderCart($chat_id, $mesasge_id);
        exit;
    }

    // حذف کل سبد
    if ($callback_data == 'clear_cart') {
        $user_detail = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);
        if ($user_detail) {
            query("UPDATE", "orders", ["status" => "cancel"], [
                ["key" => "status", "condition" => "=", "value" => "pending"],
                ["key" => "user_id", "condition" => "=", "value" => $user_detail->id]
            ]);
        }
        sendMessage($chat_id, "⛔📝 سبد خرید شما با موفقیت خالی شد", false, $mesasge_id);
        sendMainKeyboardMenu($chat_id, $mesasge_id);
        exit;
    }

    // شروع checkout
    if ($callback_data == 'checkout') {
        global $conn;
        $user_detail = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);
        if (!$user_detail) { exit; } // این خط برای جلوگیری از خطا مهم است
    
        $active_order = query("SELECT", "orders", false, [
            ["key" => "status", "condition" => "=", "value" => "pending"],
            ["key" => "user_id", "condition" => "=", "value" => $user_detail->id]
        ]);
        
        if ($active_order) {
            // --- شروع بخش جدید: چک کردن موجودی کل سبد خرید ---
            $sql = "SELECT oi.quantity, p.title, p.inventory FROM orders_item oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = :oid";
            $stmt = $conn->prepare($sql);
            $stmt->execute([':oid' => $active_order->id]);
            $cart_items = $stmt->fetchAll(PDO::FETCH_OBJ);
    
            // اگر سبد خرید خالی باشد (ممکن است آیتم‌ها حذف شده باشند)
            if (!$cart_items) {
                sendMessage($chat_id, "🛒 سبد خرید شما خالی است!", false, $mesasge_id);
                exit;
            }
    
            $out_of_stock = [];
            foreach ($cart_items as $item) {
                if ($item->inventory < $item->quantity) {
                    $out_of_stock[] = "محصول '<b>{$item->title}</b>' (موجودی: {$item->inventory} عدد)";
                }
            }
    
            if (!empty($out_of_stock)) {
                $error_msg = "❌ متاسفانه برخی از محصولات سبد شما با کمبود موجودی مواجه شده‌اند:\n\n" . implode("\n", $out_of_stock);
                $error_msg .= "\n\nلطفاً سبد خرید خود را ویرایش کرده و دوباره تلاش کنید.";
                
                global $telegram;
                $keyb = $telegram->buildInlineKeyBoard([
                    [ $telegram->buildInlineKeyBoardButton("مشاهده سبد خرید 🛒", '', 'view_cart') ]
                ]);
                sendMessage($chat_id, $error_msg, $keyb, $mesasge_id);
                exit;
            }
            // --- پایان بخش جدید ---
    
            // اگر همه چیز درست بود، فرآیند را شروع کن
            query("CREATE", "user_checkout_state", ["user_id" => $user_detail->id, "order_id" => $active_order->id, "step" => 1]);
            $txt = "مرحله 1️⃣\n\n";
            $txt .= "لطفاً نام و نام خانوادگی خود را وارد کنید:\n";
            $txt .= "(به صورت: نام نام‌خانوادگی)\n\n";
            $txt .= "مثال: علی محمدی";
            sendMessage($chat_id, $txt, false, $mesasge_id);
            
        } else {
            // اگر سفارش فعالی وجود نداشت
            sendMessage($chat_id, "🛒 سبد خرید شما خالی است!", false, $mesasge_id);
        }
    
        exit; // در پایان همیشه exit() قرار داشته باشد تا اجرای کد ادامه پیدا نکند
    }


    // لیست دسته‌ها
    if ($callback_data == 'buy_product') {
        global $telegram;
        $categories = query("SELECT", "categories", false, [["key" => "status", "condition" => "=", "value" => "enable"]], true);
        $text = "⭐️ <b>لطفا دسته‌بندی مد نظر خود را انتخاب کنید</b>\n\n";
        $option = [];
        foreach ($categories as $cat) {
            $option[] = array($telegram->buildInlineKeyBoardButton($cat->icon . " " . $cat->name, '', 'category_' . $cat->id));
        }
        $option[] = array($telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start'));
        $keyb = $telegram->buildInlineKeyBoard($option);
        sendMessage($chat_id, $text, $keyb, $mesasge_id);
        exit;
    }

    // پشتیبانی
    if ($callback_data == 'support') {
        renderSupport($chat_id, $mesasge_id);
        exit;
    }
    // if ($callback_data == 'support') {
    //     global $telegram;
    //     $setting = query("SELECT", "settings", false, [["key" => "setting_key", "condition" => "=", "value" => "support"]]);
    //     $text = "🗣️ <b>تماس با پشتیبانی</b>\n\n";
    //     $text .= "شما می‌توانید از طریق آیدی تلگرام زیر تماس بگیرید:\n\n";
    //     $text .= "<b>" . ($setting ? $setting->setting_value : "@Ielts_with_us_updated") . "</b>";
    //     $keyb = $telegram->buildInlineKeyBoard([[$telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start')]]);
    //     sendMessage($chat_id, $text, $keyb, $mesasge_id);
    //     exit;
    // }

    // سفارشات من 
    elseif ($callback_data == 'my_orders') {
        renderMyOrders($chat_id, $mesasge_id);
        exit;
    }


    // جایگزین کردن بخش راهنما با سوالات متداول
    if ($callback_data == 'show_faqs') {
        renderFAQs($chat_id, $mesasge_id);
        exit;
    }

    // نمایش پاسخ سوال
    if (strpos($callback_data, 'faq_answer_') === 0) {
        global $telegram;
        $faq_id = str_replace('faq_answer_', '', $callback_data);
        $faq = query("SELECT", "faqs", false, [["key"=>"id","condition"=>"=","value"=>$faq_id]]);

        if ($faq) {
            $text = "❓ <b>سوال:</b>\n" . $faq->question . "\n\n";
            $text .= "✅ <b>پاسخ:</b>\n" . $faq->answer;
            $keyb = $telegram->buildInlineKeyBoard([[ $telegram->buildInlineKeyBoardButton("بازگشت به لیست سوالات 🔙", '', 'show_faqs') ]]);
            sendMessage($chat_id, $text, $keyb, $mesasge_id);
        }
        exit;
    }


    // راهنما
    if ($callback_data == 'help') {
        renderHelp($chat_id, $mesasge_id);
        exit;
    }
    // if ($callback_data == 'help') {
    //     global $telegram;
    //     $text = "❓ <b>راهنمای استفاده از ربات</b>\n\n";
    //     $text .= "1️⃣ <b>خریداری محصول:</b>\n";
    //     $text .= "   • بر روی گزینه 'خریداری محصول' کلیک کنید\n";
    //     $text .= "   • دسته‌بندی را انتخاب کنید\n";
    //     $text .= "   • محصول را انتخاب کنید و مقدار را تعیین کنید\n\n";
    //     $text .= "2️⃣ <b>سبد خرید:</b>\n";
    //     $text .= "   • تمام محصولات انتخاب‌شده در سبد خرید ذخیره می‌شوند\n";
    //     $text .= "   • می‌توانید محصولات را حذف کنید\n\n";
    //     $text .= "3️⃣ <b>تکمیل خرید:</b>\n";
    //     $text .= "   • اطلاعات فردی را درست کنید\n";
    //     $text .= "   • عکس فیش واریزی را ارسال کنید\n\n";
    //     $text .= "4️⃣ <b>پیگیری سفارش:</b>\n";
    //     $text .= "   • بر روی 'سفارشات من' کلیک کنید\n";
    //     $text .= "   • وضعیت سفارش را مشاهده کنید";
    //     $keyb = $telegram->buildInlineKeyBoard([[$telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start')]]);
    //     sendMessage($chat_id, $text, $keyb, $mesasge_id);
    //     exit;
    // }

    // بازگشت
    if ($callback_data == 'start') {
        sendMainKeyboardMenu($chat_id, $mesasge_id);
        exit;
    }
}

/* =================== پیام‌های متنی =================== */
if (!isset($resultTelegram['callback_query'])) {

    // /start
    $main_panel = '🏠 پنل اصلی';
    if ($text == "/start" || $text == $main_panel){
        $getUser = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);
        if (!$getUser)
            query("CREATE", "users", ["chat_id" => $chat_id, "name" => $telegram->FirstName(), "status" => "enable"]);
        sendMainKeyboardMenu($chat_id);
        sendUserPersistentKeyboard($chat_id);
        exit;
    }

    $buy_product_text = '🛍️ خرید محصول';
    $view_cart_text = '🛒 سبد خرید';
    $my_orders_text = '✉️ سفارشات من';
    $support_text = '🗣️ پشتیبانی';
    $faqs_text = '❓ سوالات متداول'; 

    if ($text) { 
        switch ($text) {
            case $buy_product_text:
                global $telegram;
                $categories = query("SELECT", "categories", false, [["key"=>"status","condition"=>"=","value"=>"enable"]], true);
                if (!$categories || count($categories) == 0) {
                    sendMessage($chat_id, "❌ در حال حاضر دسته‌بندی فعالی وجود ندارد.");
                    exit;
                }
                $msg = "⭐️ <b>لطفا دسته‌بندی مد نظر خود را انتخاب کنید</b>\n\n";
                $option = [];
                foreach ($categories as $cat) {
                    $option[] = array($telegram->buildInlineKeyBoardButton($cat->icon . " " . $cat->name, '', 'category_' . $cat->id));
                }
                $option[] = array($telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start'));
                $keyb = $telegram->buildInlineKeyBoard($option);
                sendMessage($chat_id, $msg, $keyb);
                exit;

            case $view_cart_text:
                renderCart($chat_id);
                exit;

            case $my_orders_text:
                // ✅ اصلاح شد: فراخوانی تابع آماده
                renderMyOrders($chat_id);
                exit;

            case $support_text:
                // ✅ تکمیل شد: فراخوانی تابع آماده
                renderSupport($chat_id);
                exit;
                
            case $faqs_text:
                // ✅ اصلاح شد: فراخوانی تابع سوالات متداول
                renderFAQs($chat_id);
                exit;
        }
    }


    // حذف آیتم از سبد با دستور /delete_item_{id}
    if (strpos($text, '/delete_item_') === 0) {
        $orderitem_id = intval(substr($text, strlen('/delete_item_')));
        $user_detail = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);
        if ($user_detail) {
            $active_order = query("SELECT", "orders", false, [
                ["key" => "status", "condition" => "=", "value" => "pending"],
                ["key" => "user_id", "condition" => "=", "value" => $user_detail->id]
            ]);
            if ($active_order) {
                $item = query("SELECT", "orders_item", false, [
                    ["key" => "id", "condition" => "=", "value" => $orderitem_id],
                    ["key" => "order_id", "condition" => "=", "value" => $active_order->id]
                ]);
                if ($item) {
                    global $conn;
                    $stmt = $conn->prepare("DELETE FROM orders_item WHERE id = :id");
                    $stmt->bindValue(':id', $orderitem_id, PDO::PARAM_INT);
                    $stmt->execute();
                    sendMessage($chat_id, "🗑️ آیتم از سبد خرید حذف شد.");
                    renderCart($chat_id); // بدون دست‌کاری کلاس تلگرام
                } else {
                    sendMessage($chat_id, "⚠️ آیتم معتبر یافت نشد.");
                }
            } else {
                sendMessage($chat_id, "📪 سبد خریدی برای شما پیدا نشد.");
            }
        } else {
            sendMessage($chat_id, "❌ کاربر یافت نشد.");
        }
        exit;
    }

    // مراحل checkout
    $user_detail = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);
    if ($user_detail) {
        $checkout_state = query("SELECT", "user_checkout_state", false, [["key" => "user_id", "condition" => "=", "value" => $user_detail->id]], false, "id DESC");
        if ($checkout_state) {
            $step = intval($checkout_state->step);

            // مرحله 1: نام و نام خانوادگی
            if ($step == 1 && $text && $text[0] != '/') {
                $names = explode(' ', trim($text));
                if (count($names) >= 2) {
                    $first_name = $names[0];
                    $last_name = implode(' ', array_slice($names, 1));
                    $data = json_encode(["first_name" => $first_name, "last_name" => $last_name], JSON_UNESCAPED_UNICODE);
                    query("UPDATE", "user_checkout_state", ["step" => 2, "step_data" => $data], [["key" => "id", "condition" => "=", "value" => $checkout_state->id]]);
                    $txt = "مرحله 2️⃣\n\n";
                    $txt .= "لطفاً آدرس خود را وارد کنید:\n";
                    $txt .= "(آدرس کامل شهر، خیابان، پلاک و...)";
                    sendMessage($chat_id, $txt);
                } else {
                    sendMessage($chat_id, "❌ لطفاً نام و نام خانوادگی را به صورت صحیح وارد کنید:\nمثال: علی محمدی");
                }
                exit;
            }

            // مرحله 2: آدرس
            if ($step == 2 && $text && $text[0] != '/') {
                $step_data = json_decode($checkout_state->step_data, true) ?: [];
                $step_data['address'] = $text;
                $data = json_encode($step_data, JSON_UNESCAPED_UNICODE);
                query("UPDATE", "user_checkout_state", ["step" => 3, "step_data" => $data], [["key" => "id", "condition" => "=", "value" => $checkout_state->id]]);
                $txt = "مرحله 3️⃣\n\n";
                $txt .= "لطفاً شماره تلفن خود را وارد کنید:\n";
                $txt .= "(فقط اعداد - مثال: 09123456789)";
                sendMessage($chat_id, $txt);
                exit;
            }

            // مرحله 3: تلفن
            if ($step == 3 && $text && $text[0] != '/') {
                $phoneNumber = convertNumbersToEnglish($text);
                if (preg_match('/^09\d{9}$/', $phoneNumber)) {
                    global $conn;
                    $step_data = json_decode($checkout_state->step_data, true) ?: [];
                    $step_data['phone'] = $phoneNumber;

                    $sql = "SELECT SUM(products.price * orders_item.quantity) as total
                            FROM `orders_item`
                            LEFT JOIN products ON orders_item.product_id = products.id
                            WHERE orders_item.order_id=:oid";
                    $stmt = $conn->prepare($sql);
                    $stmt->bindValue(':oid', $checkout_state->order_id, PDO::PARAM_INT);
                    $stmt->execute();
                    $row = $stmt->fetch(PDO::FETCH_OBJ);
                    $total_price = $row && $row->total ? intval($row->total) : 0;

                    $step_data['total_price'] = $total_price;
                    $data = json_encode($step_data, JSON_UNESCAPED_UNICODE);
                    query("UPDATE", "user_checkout_state", ["step" => 4, "step_data" => $data], [["key" => "id", "condition" => "=", "value" => $checkout_state->id]]);

                    $bank_setting = query("SELECT", "settings", false, [["key"=>"setting_key","condition"=>"=","value"=>"bank_info"]]);
                    $bank_info = $bank_setting ? $bank_setting->setting_value : "شماره کارت هنوز تنظیم نشده است.";
                
                    $txt = "مرحله 4️⃣\n\n";
                    $txt .= "💳 <b>اطلاعات واریز:</b>\n";
                    $txt .= "<code>" . $bank_info . "</code>\n\n";
                    $txt .= "💰 <b>مبلغ کل:</b> " . number_format($total_price) . " تومان\n\n";
                
                    $txt .= "📸 <b>فقط تصویر ارسال کنید</b> (Photo یا Document با نوع تصویر). فایل‌های غیرتصویری یا متن پذیرفته نمی‌شود.\n\n";

                    $txt .= "لطفاً پس از واریز، عکس فیش واریزی خود را ارسال کنید:";
                    sendMessage($chat_id, $txt);
                } else {
                    sendMessage($chat_id, "❌ شماره تلفن وارد شده صحیح نیست.\nلطفاً شماره تلفن خود را به صورت صحیح وارد کنید:\nمثال: 09123456789");
                }
                exit;
            }
        }
    }

    // دریافت رسید در مرحله 4 (هم photo هم document تصویری)
    if (isset($resultTelegram['message']) && is_array($resultTelegram['message'])) {
        // فقط اگر در مرحله 4 هستیم دنبال رسید بگردیم
        $user_detail = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);
        if ($user_detail) {
            $checkout_state = query("SELECT", "user_checkout_state", false, [["key" => "user_id", "condition" => "=", "value" => $user_detail->id]], false, "id DESC");
            if ($checkout_state && intval($checkout_state->step) == 4) {

                // 1) اگر تصویر نیامده و کاربر متن داده:
                $file_id = extractImageFileIdFromMessage($resultTelegram);

                if (!$file_id) {
                    // هیچ تصویر سازگار (photo/document image) در پیام نبود
                    sendMessage(
                        $chat_id,
                        "❗️ لطفاً برای تکمیل سفارش، یک <b>تصویرِ رسید</b> ارسال کنید.\n\n"
                        . "راهنما:\n"
                        . "• می‌توانید عکس را به صورت Photo بفرستید.\n"
                        . "• یا اگر فایل‌تان Document است، فقط مطمئن باشید نوع آن تصویر باشد (jpg/png/webp).\n"
                        . "• اگر اشتباه متنی فرستادی، همین حالا دوباره یک عکس بفرست."
                    );
                    // در مرحله ۴ باقی بماند
                    return;
                }

                // 2) تلاش برای دانلود تصویر
                list($ok, $pathOrErr) = downloadTelegramFileById($file_id, 'uploads');
                if (!$ok) {
                    sendMessage(
                        $chat_id,
                        "⚠️ خطا در دریافت فایل: " . $pathOrErr . "\n"
                        . "لطفاً دوباره عکس رسید را ارسال کنید یا نوع ارسال را تغییر دهید (Photo)."
                    );
                    return;
                }
                $saved_path = $pathOrErr;

                // 3) ثبت اطلاعات سفارش و تغییر وضعیت
                $step_data = json_decode($checkout_state->step_data, true) ?: [];

                query("CREATE", "order_details", [
                    "order_id" => $checkout_state->order_id,
                    "first_name" => $step_data['first_name'] ?? '',
                    "last_name" => $step_data['last_name'] ?? '',
                    "address" => $step_data['address'] ?? '',
                    "phone_number" => $step_data['phone'] ?? '',
                    "receipt_image_url" => $saved_path,
                    "status" => "pending"
                ]);

                snapshotOrderDetails($checkout_state->order_id);

                query("UPDATE", "orders", ["status" => "payed"], [["key" => "id", "condition" => "=", "value" => $checkout_state->order_id]]);
                query("UPDATE", "user_checkout_state", ["step" => 0], [["key" => "id", "condition" => "=", "value" => $checkout_state->id]]);

                $order_info = query("SELECT", "orders", false, [["key" => "id", "condition" => "=", "value" => $checkout_state->order_id]]);
                $track_id_to_show = $order_info ? $order_info->trackId : $checkout_state->order_id;


                $txt = "✅ <b>رسید شما دریافت شد و سفارش برای ادمین ارسال گردید.</b>\n\n";
                $txt .= "از خرید شما متشکریم 🙏\n\n";
                $txt .= "🆔 <b>کد رهگیری:</b> " . $track_id_to_show . "\n";
                $txt .= "👤 نام: " . (($step_data['first_name'] ?? '') . " " . ($step_data['last_name'] ?? '')) . "\n";
                $txt .= "📍 آدرس: " . ($step_data['address'] ?? '') . "\n";
                $txt .= "📱 تلفن: " . ($step_data['phone'] ?? '') . "\n";
                $txt .= "💵 مبلغ کل: " . number_format(intval($step_data['total_price'] ?? 0)) . " تومان\n";
                $txt .= "⏰ وضعیت: ⏳ در انتظار تایید\n\n";
                $txt .= "می‌توانید در بخش «سفارشات من» وضعیت را ببینید.";

                $keyb = $telegram->buildInlineKeyBoard([[$telegram->buildInlineKeyBoardButton("بازگشت به منوی اصلی 🏠", '', 'start')]]);
                sendMessage($chat_id, $txt, $keyb);

                notifyAdminOfNewOrder($checkout_state->order_id);

                return;
            }
        }
    }
}
