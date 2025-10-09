<?php
date_default_timezone_set('Asia/Tehran');

//ini_set('display_errors', 1); // این خطوط را برای دیباگ نگه دارید
//error_reporting(E_ALL);

require_once 'config/db.php';
require_once 'Telegram.php';
require_once 'functions.php';
require_once 'admin_functions.php';

/* =================== تنظیمات پایه =================== */
$BOT_TOKEN = "8267056539:AAHUjlj1dK5yVJl0U0UiRq13_U0-XxIRAvg"; // ❗️ توکن ربات
$ADMIN_CHAT_ID = "2020715168"; // ❗️ آیدی عددی ادمین
$BASE_PUBLIC_URL = "https://098a6b7a929f.ngrok-free.app";


$telegram = new Telegram($BOT_TOKEN);

/* =================== خواندن ورودی و تعریف متغیرهای اصلی =================== */
$resultTelegram = $telegram->getData();
$chat_id = $telegram->ChatID();
$text = $telegram->Text();
$mesasge_id = $resultTelegram['callback_query']['message']['message_id'] ?? false;

// ۲. بررسی هویت کاربر (ادمین است یا نه؟)
$is_admin = ($chat_id == $ADMIN_CHAT_ID);
// sendMessage($chat_id, "Debug Info:\nis_admin = " . ($is_admin ? "true" : "false"));
// ۳. ارجاع به فایل منطق مربوطه
if ($is_admin) {
    require_once 'admin_handler.php';
} else {
    require_once 'user_handler.php';
}