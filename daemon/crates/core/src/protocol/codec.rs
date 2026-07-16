use super::Request;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub fn encode_request(req: &Request) -> Result<Vec<u8>, String> {
    let body = serde_json::to_vec(req).map_err(|e| e.to_string())?;
    Ok(frame(body))
}

fn frame(body: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    out
}

pub fn decode_request(buf: &[u8]) -> Result<Request, String> {
    serde_json::from_slice(&buf[4..]).map_err(|e| e.to_string())
}

pub fn decode_server_message(buf: &[u8]) -> Result<super::ServerMessage, String> {
    serde_json::from_slice(&buf[4..]).map_err(|e| e.to_string())
}

pub async fn read_frame<R: AsyncReadExt + Unpin>(reader: &mut R) -> Result<Vec<u8>, String> {
    let mut len_bytes = [0u8; 4];
    reader
        .read_exact(&mut len_bytes)
        .await
        .map_err(|e| e.to_string())?;
    let len = u32::from_be_bytes(len_bytes) as usize;
    let mut body = vec![0u8; len];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|e| e.to_string())?;
    Ok(body)
}

pub async fn write_frame<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    body: &[u8],
) -> Result<(), String> {
    writer
        .write_all(&(body.len() as u32).to_be_bytes())
        .await
        .map_err(|e| e.to_string())?;
    writer.write_all(body).await.map_err(|e| e.to_string())?;
    writer.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}
