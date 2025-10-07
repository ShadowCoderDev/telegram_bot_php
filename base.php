<?php
//file_put_contents('is_running_test.log', date('Y-m-d H:i:s') . " - Script was executed!\n", FILE_APPEND);
//echo 'its fine';
//file_put_contents('debug.log', "Script was executed! \n", FILE_APPEND);

include 'Telegram.php';

$telegram = new Telegram('8267056539:AAHUjlj1dK5yVJl0U0UiRq13_U0-XxIRAvg');

$telegram_results = $telegram->getData();
$chat_id = $telegram->ChatID();
$text_chat = $telegram->Text();

$myCommands = false;


if( $text_chat == '/start' || $text_chat == 'شروع' || $text_chat == 'بازگشت'){
    $myCommands = true;

    $option = array(
        //First row
        array($telegram->buildInlineKeyBoardButton("شروع", '', '/start')),
        //Second row
        array($telegram->buildInlineKeyBoardButton("اطلاعات ربات", '', '/info'), $telegram->buildInlineKeyBoardButton("اطلاعات خودم", '', '/me')),
         );
    $keyb = $telegram->buildInlineKeyBoard($option, $onetime=false);
    $content = array('chat_id' => $chat_id, 'reply_markup' => $keyb, 'text' => "سلام خوبی میتونی سفارش رو تکمیل کنی ...");
    $telegram->sendMessage($content);
}

if ( $text_chat == '/info' || $text_chat == 'اطلاعات ربات'){
    $myCommands = true;
    $myProfile = $telegram->getMe()["result"]["first_name"];

    $option = array(
        //First row
        array($telegram->buildInlineKeyBoardButton("بازگشت",'', '/start')),
    );
    $keyb = $telegram->buildInlineKeyBoard($option, $onetime=false);

    $content = array('chat_id' => $chat_id, 'reply_markup' => $keyb, 'text' => $myProfile,'message_id'=>$telegram_results['callback_query']['message']['message_id']);
    $telegram->editMessageText($content);
}

if ( $text_chat == '/me' || $text_chat == 'اطلاعات خودم'){
    $myCommands = true;
    $myProfile = $telegram->Chat()["first_name"];


    $option = array(
        //First row
        array($telegram->buildInlineKeyBoardButton("بازگشت",'', '/start')),
    );
    $keyb = $telegram->buildInlineKeyBoard($option, $onetime=false);


    $content = array('chat_id' => $chat_id, 'reply_markup' => $keyb, 'text' => $myProfile, 'message_id'=>$telegram_results['callback_query']['message']['message_id']);
    $telegram->editMessageText($content);
}

if ( $text_chat == '/keyboard'){
    $myCommands = true;
    $content = array('chat_id' => $chat_id, 'text' => "keyboard is called!");
    $telegram->sendMessage($content);
}


if (! $myCommands){
    $content = array('chat_id' => $chat_id, 'text' => 'دستور اشتباه وارد کرید!');;
    $telegram->sendMessage($content);
}


//$content = array('chat_id' => $chat_id, 'text' => $text_chat);
//$telegram->sendMessage($content);



