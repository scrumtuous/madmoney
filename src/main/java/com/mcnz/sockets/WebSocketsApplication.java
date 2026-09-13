package com.mcnz.sockets;

import jakarta.websocket.OnMessage;
import jakarta.websocket.Session;
import jakarta.websocket.server.ServerEndpoint;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.web.socket.server.standard.ServerEndpointExporter;

@SpringBootApplication(proxyBeanMethods = false)
@ServerEndpoint("/madmoney")
public class WebSocketsApplication {

    public static void main(String[] args) {
        SpringApplication.run(WebSocketsApplication.class, args);
    }

    @Bean
    public ServerEndpointExporter serverEndpointExporter() {
        return new ServerEndpointExporter();
    }

    @OnMessage
    public void onMessage(String message, Session sender) {

        for (Session client : sender.getOpenSessions()) {
            client.getAsyncRemote().sendText(message);
        }
    }
}